import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { difficultyForBlock, BASE_UNITS_PER_RPOW } from '../schedule.js';
import { macMintChallenge, type MintChallengeEnvelope } from '../mint-challenge.js';
import { TtlCache } from '../cache.js';

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
  const counterCache = new TtlCache<'singleton', CounterSnapshot>({ ttlMs: COUNTER_CACHE_MS, maxSize: 1 });

  async function readCounters(): Promise<CounterSnapshot> {
    return counterCache.get('singleton', async () => {
      const { rows } = await app.pool.query<{ name: string; value: string }>(
        `SELECT name, value::text AS value
           FROM app_counters
          WHERE name IN ('minted_supply','block_height')`,
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

  app.post('/challenge', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { mintedBaseUnits, blockHeight } = await readCounters();
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    if (mintedBaseUnits >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
    }

    const difficulty = difficultyForBlock(blockHeight, {
      difficultyStartBits: app.config.difficultyStartBits,
      difficultyStepBlocks: app.config.difficultyStepBlocks,
      difficultyMaxBits: app.config.difficultyMaxBits,
    });

    const id = randomUUID();
    const noncePrefix = randomBytes(16);
    const now = Date.now();
    const envelope: MintChallengeEnvelope = {
      challenge_id: id,
      user_pubkey: s.pubkey,
      nonce_prefix: noncePrefix.toString('hex'),
      difficulty_bits: difficulty,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
      domain: 'rpow4.mint',
    };
    return {
      challenge_id: envelope.challenge_id,
      nonce_prefix: envelope.nonce_prefix,
      difficulty_bits: envelope.difficulty_bits,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at,
      challenge_mac: macMintChallenge(envelope, app.config.sessionSecret),
    };
  });
}
