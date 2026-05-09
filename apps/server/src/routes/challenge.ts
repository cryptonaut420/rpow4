import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { difficultyBitsForSupply, BASE_UNITS_PER_RPOW } from '../schedule.js';
import { macMintChallenge, type MintChallengeEnvelope } from '../mint-challenge.js';
import { TtlCache } from '../cache.js';

// Supply count is checked twice per mining round: here at /challenge
// (advisory only — used to pick difficulty and fail-fast at cap) and again
// inside /mint under an advisory lock (authoritative). Cache for 5s; the
// cap check is harmless to be slightly stale because /mint re-checks
// under the lock.
const SUPPLY_CACHE_MS = 5_000;

export async function challengeRoutes(app: FastifyInstance) {
  const supplyCache = new TtlCache<'singleton', bigint>({ ttlMs: SUPPLY_CACHE_MS, maxSize: 1 });

  async function mintedSupplyBaseUnits(): Promise<bigint> {
    return supplyCache.get('singleton', async () => {
      const { rows } = await app.pool.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
      );
      return rows[0] ? BigInt(rows[0].value) : 0n;
    });
  }

  app.post(
    '/challenge',
    {
      // Issuing a mint challenge is cheap (no DB write) but we still
      // bound it per IP to keep the response stream lean under attack.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const minted = await mintedSupplyBaseUnits();
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    if (minted >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
    }

    const scheduledBits = difficultyBitsForSupply(minted, {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    });
    const difficulty = Math.max(app.config.difficultyFloor, scheduledBits);

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
      domain: 'rpow2.mint',
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
