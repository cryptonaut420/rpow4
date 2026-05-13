import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { difficultyForBlock } from '../schedule.js';
import { macMintChallenge, type MintChallengeEnvelope } from '../mint-challenge.js';
import { TtlCache } from '../cache.js';
import { assetToScheduleOpts, resolveAsset } from '../assets.js';

interface CounterSnapshot {
  mintedBaseUnits: bigint;
  blockHeight: bigint;
}

// Counter snapshot is checked twice per mining round: here at /challenge
// (advisory only — used to pick difficulty and fail-fast at cap) and again
// inside /mint under an advisory lock (authoritative). Cache for 5s; the
// cap and difficulty hints are harmless to be slightly stale because
// /mint re-checks under the lock and returns CHALLENGE_EXPIRED if the
// schedule advanced underneath the client.
const COUNTER_CACHE_MS = 5_000;

export async function challengeRoutes(app: FastifyInstance) {
  const counterCache = new TtlCache<string, CounterSnapshot>({ ttlMs: COUNTER_CACHE_MS, maxSize: 10_000 });

  async function readCounters(assetId: string): Promise<CounterSnapshot> {
    return counterCache.get(assetId, async () => {
      const { rows } = await app.pool.query<{ name: string; value: string }>(
        `SELECT name, value::text AS value
           FROM app_counters
          WHERE asset_id=$1::uuid AND name IN ('minted_supply','block_height')`,
        [assetId],
      );
      let mintedBaseUnits = 0n;
      let blockHeight = 0n;
      for (const r of rows) {
        if (r.name === 'minted_supply') mintedBaseUnits = BigInt(r.value);
        else if (r.name === 'block_height') blockHeight = BigInt(r.value);
      }
      return { mintedBaseUnits, blockHeight };
    });
  }

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    if (asset.assetKind !== 'mineable') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'this asset is not mineable' });
    }
    if (asset.miningAlgo !== 'rpow_classic') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'unsupported mining algorithm' });
    }

    const { mintedBaseUnits, blockHeight } = await readCounters(asset.id);
    const capBaseUnits = asset.maxSupplyBaseUnits ?? (2n ** 63n - 1n);
    if (asset.supplyMode === 'capped' && mintedBaseUnits >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: 'supply cap reached' });
    }

    const difficulty = difficultyForBlock(blockHeight, assetToScheduleOpts(asset));

    const id = randomUUID();
    const noncePrefix = randomBytes(16);
    const now = Date.now();
    const envelope: MintChallengeEnvelope = {
      asset_id: asset.id,
      challenge_id: id,
      user_pubkey: s.pubkey,
      nonce_prefix: noncePrefix.toString('hex'),
      difficulty_bits: difficulty,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
      domain: 'rpow4.asset.mint.v1',
    };
    return {
      asset_id: envelope.asset_id,
      asset_slug: asset.slug,
      asset_code: asset.displayCode,
      challenge_id: envelope.challenge_id,
      nonce_prefix: envelope.nonce_prefix,
      difficulty_bits: envelope.difficulty_bits,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at,
      challenge_mac: macMintChallenge(envelope, app.config.sessionSecret),
    };
  };

  app.post('/challenge', handler);
  app.post('/assets/:asset_slug/challenge', handler);
}
