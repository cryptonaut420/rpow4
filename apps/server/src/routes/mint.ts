import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyCanonical } from '@rpow/shared';
import { readSession } from './auth.js';
import { verifySolution } from '../pow.js';
import { signTokenPayload } from '../signing.js';
import { withTx } from '../db.js';
import { currentRewardBaseUnits, BASE_UNITS_PER_RPOW } from '../schedule.js';
import { macMintChallenge, macsEqual, type MintChallengeEnvelope } from '../mint-challenge.js';

const Body = z.object({
  challenge_id: z.string().uuid(),
  nonce_prefix: z.string().regex(/^[0-9a-f]{32}$/),
  difficulty_bits: z.number().int().min(4).max(40),
  issued_at: z.string(),
  expires_at: z.string(),
  challenge_mac: z.string().regex(/^[0-9a-f]{64}$/),
  solution_nonce: z.string().regex(/^\d{1,20}$/),
  client_signature_base58: z.string().min(64).max(128),
});

export async function mintRoutes(app: FastifyInstance) {
  app.post('/mint', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    // Per-event client signature: the miner signs over challenge_id +
    // solution_nonce. The challenge envelope is separately MAC'd by the
    // server so difficulty/expiry cannot be tampered with.
    const sigOk = verifyCanonical(
      'mint',
      { challenge_id: parsed.data.challenge_id, solution_nonce: parsed.data.solution_nonce },
      parsed.data.client_signature_base58,
      s.pubkey,
    );
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'mint signature does not verify' });
    }

    const challengeEnvelope: MintChallengeEnvelope = {
      challenge_id: parsed.data.challenge_id,
      user_pubkey: s.pubkey,
      nonce_prefix: parsed.data.nonce_prefix,
      difficulty_bits: parsed.data.difficulty_bits,
      issued_at: parsed.data.issued_at,
      expires_at: parsed.data.expires_at,
      domain: 'rpow2.mint',
    };
    const expectedMac = macMintChallenge(challengeEnvelope, app.config.sessionSecret);
    if (!macsEqual(expectedMac, parsed.data.challenge_mac)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'challenge mac mismatch' });
    }
    const expiresAtMs = Date.parse(parsed.data.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
      return reply.code(410).send({ error: 'CHALLENGE_EXPIRED', message: 'expired' });
    }
    const nonce = BigInt(parsed.data.solution_nonce);
    if (!verifySolution(Buffer.from(parsed.data.nonce_prefix, 'hex'), nonce, parsed.data.difficulty_bits)) {
      return reply.code(400).send({ error: 'INVALID_SOLUTION', message: 'hash does not meet difficulty' });
    }

    const result = await withTx(app.pool, async (c) => {
      // Serialize all mint commits on a single advisory lock.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_mint_supply'))`);

      const accepted = await c.query<{ id: string }>(
        `SELECT id FROM ledger_events
         WHERE event_type='MINT' AND challenge_id=$1
         LIMIT 1`,
        [parsed.data.challenge_id],
      );
      if (accepted.rows[0]) return { error: 'CHALLENGE_ALREADY_CLAIMED' as const, message: 'already claimed' };

      const { rows: counterRows } = await c.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
      );
      const mintedBaseUnits = counterRows[0] ? BigInt(counterRows[0].value) : 0n;

      const reward = currentRewardBaseUnits(mintedBaseUnits, {
        maxSupplyRpow: app.config.mintMaxSupply,
      });
      if (reward === 0n) {
        return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached or reward floored' };
      }

      const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
      const supplyResult = await c.query(
        `UPDATE app_counters SET value = value + $2::bigint
         WHERE name='minted_supply' AND value + $2::bigint <= $1::bigint`,
        [capBaseUnits.toString(), reward.toString()],
      );
      if (supplyResult.rowCount === 0) {
        return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached' };
      }

      const eventId = randomUUID();
      const issuedAt = new Date();
      const sig = signTokenPayload(
        { id: eventId, owner_pubkey: s.pubkey, value: reward, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );

      await c.query(
        `INSERT INTO account_balances(pubkey, spendable_base_units, minted_base_units, updated_at)
         VALUES($1, $2, $2, now())
         ON CONFLICT (pubkey) DO UPDATE SET
           spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
           minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
           updated_at = now()`,
        [s.pubkey, reward.toString()],
      );

      await c.query(
        `UPDATE ledger_stats
         SET value = value + $1::bigint, updated_at = now()
         WHERE name='circulating_supply'`,
        [reward.toString()],
      );

      await c.query(
        `INSERT INTO ledger_events(
           id, event_type, actor_pubkey, amount, challenge_id, solution_nonce,
           client_signature_base58, server_sig, created_at
         )
         VALUES($1, 'MINT', $2, $3, $4, $5, $6, $7, $8)`,
        [
          eventId,
          s.pubkey,
          reward.toString(),
          parsed.data.challenge_id,
          parsed.data.solution_nonce,
          parsed.data.client_signature_base58,
          sig,
          issuedAt,
        ],
      );
      return { token: { id: eventId, value_base_units: reward.toString(), issued_at: issuedAt.toISOString() } };
    });

    if ('error' in result) {
      const status = result.error === 'SUPPLY_EXHAUSTED' ? 410 : 400;
      return reply.code(status).send(result);
    }
    return result;
  });
}
