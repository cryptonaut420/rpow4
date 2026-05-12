import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyCanonical } from '@rpow/shared';
import { verifySolution } from '../pow.js';
import { signTokenPayload } from '../signing.js';
import { withTxRetry } from '../db.js';
import {
  currentRewardForBlock,
  difficultyForBlock,
} from '../schedule.js';
import { macMintChallenge, macsEqual, type MintChallengeEnvelope } from '../mint-challenge.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import { assetToScheduleOpts, DEFAULT_ASSET_SLUG, resolveAsset } from '../assets.js';

const Body = z.object({
  asset_id: z.string().uuid().optional(),
  challenge_id: z.string().uuid(),
  nonce_prefix: z.string().regex(/^[0-9a-f]{32}$/),
  difficulty_bits: z.number().int().min(4).max(64),
  issued_at: z.string(),
  expires_at: z.string(),
  challenge_mac: z.string().regex(/^[0-9a-f]{64}$/),
  solution_nonce: z.string().regex(/^\d{1,20}$/),
  client_signature_base58: z.string().min(64).max(128),
});

export async function mintRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    if (parsed.data.asset_id && parsed.data.asset_id !== asset.id) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'asset mismatch' });
    }

    // Per-event client signature: the miner signs over challenge_id +
    // solution_nonce. The challenge envelope is separately MAC'd by the
    // server so difficulty/expiry cannot be tampered with.
    const scopedSigBody = { asset_id: asset.id, challenge_id: parsed.data.challenge_id, solution_nonce: parsed.data.solution_nonce };
    const legacySigBody = { challenge_id: parsed.data.challenge_id, solution_nonce: parsed.data.solution_nonce };
    const sigOk = verifyCanonical(
      'mint',
      parsed.data.asset_id || asset.slug !== DEFAULT_ASSET_SLUG ? scopedSigBody : legacySigBody,
      parsed.data.client_signature_base58,
      s.pubkey,
    ) || (asset.slug === DEFAULT_ASSET_SLUG && verifyCanonical('mint', legacySigBody, parsed.data.client_signature_base58, s.pubkey));
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'mint signature does not verify' });
    }

    const challengeEnvelope: MintChallengeEnvelope = {
      asset_id: asset.id,
      challenge_id: parsed.data.challenge_id,
      user_pubkey: s.pubkey,
      nonce_prefix: parsed.data.nonce_prefix,
      difficulty_bits: parsed.data.difficulty_bits,
      issued_at: parsed.data.issued_at,
      expires_at: parsed.data.expires_at,
      domain: 'rpow4.asset.mint.v1',
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

    const scheduleOpts = assetToScheduleOpts(asset);

    const result = await withTxRetry(
      app.pool,
      async (c) => {
        // Serialize all mint commits on a single advisory lock.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_mint_supply'), hashtext($1))`, [asset.id]);

        const accepted = await c.query<{ event_id: string }>(
          `SELECT event_id FROM ledger_mint_claims WHERE asset_id=$1::uuid AND challenge_id=$2 LIMIT 1`,
          [asset.id, parsed.data.challenge_id],
        );
        if (accepted.rows[0]) return { error: 'CHALLENGE_ALREADY_CLAIMED' as const, message: 'already claimed' };

        // Read both counters in one round-trip. The schedule is purely
        // a function of block_height; the cap check uses minted_supply.
        const { rows: counterRows } = await c.query<{ name: string; value: string }>(
          `SELECT name, value::text AS value
             FROM app_counters
            WHERE asset_id=$1::uuid AND name IN ('minted_supply','block_height')`,
          [asset.id],
        );
        let mintedBaseUnits = 0n;
        let blockHeight = 0n;
        for (const r of counterRows) {
          if (r.name === 'minted_supply') mintedBaseUnits = BigInt(r.value);
          else if (r.name === 'block_height') blockHeight = BigInt(r.value);
        }

        // Reward and difficulty are stamped at the block height the
        // mint will be sealed AT (= current height; the bump to
        // height+1 happens further down on success).
        const reward = currentRewardForBlock(blockHeight, scheduleOpts);
        if (reward === 0n) {
          return { error: 'SUPPLY_EXHAUSTED' as const, message: 'reward floored to zero — schedule terminated' };
        }
        const expectedDifficulty = difficultyForBlock(blockHeight, scheduleOpts);
        if (parsed.data.difficulty_bits !== expectedDifficulty) {
          // Schedule advanced between challenge issuance and mint
          // submission. Reject so the client refetches a current
          // challenge instead of mining against a stale difficulty.
          return {
            error: 'CHALLENGE_EXPIRED' as const,
            message: 'difficulty changed between challenge and mint; request a new challenge',
          };
        }

        const capBaseUnits = asset.maxSupplyBaseUnits ?? (2n ** 63n - 1n);
        // Atomically bump minted_supply (with cap guard) AND block_height.
        // If the cap guard fails we bump nothing — block_height only
        // advances when an event is actually issued.
        const supplyResult = await c.query(
          `UPDATE app_counters
             SET value = value + (CASE
               WHEN name = 'minted_supply' THEN $1::bigint
               ELSE 1::bigint
             END)
           WHERE asset_id=$3::uuid
             AND name IN ('minted_supply','block_height')
             AND ($4::boolean OR (SELECT value FROM app_counters WHERE asset_id=$3::uuid AND name='minted_supply') + $1::bigint <= $2::bigint)`,
          [reward.toString(), capBaseUnits.toString(), asset.id, String(asset.supplyMode === 'unlimited')],
        );
        if (supplyResult.rowCount !== 2) {
          return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached' };
        }

        const eventId = randomUUID();
        await c.query(
          `INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`,
          [eventId, asset.id],
        );

        await c.query(
          `INSERT INTO ledger_mint_claims(asset_id, challenge_id, event_id, actor_pubkey)
           VALUES($1::uuid, $2, $3, $4)`,
          [asset.id, parsed.data.challenge_id, eventId, s.pubkey],
        );

        const issuedAt = new Date();
        const sig = signTokenPayload(
          { id: eventId, owner_pubkey: s.pubkey, value: reward, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );

        await c.query(
          `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, blocks_mined, events_count, updated_at)
           VALUES($1::uuid, $2, $3, $3, 1, 1, now())
           ON CONFLICT (asset_id, pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
             blocks_mined = account_balances.blocks_mined + 1,
             events_count = account_balances.events_count + 1,
             updated_at = now()`,
          [asset.id, s.pubkey, reward.toString()],
        );

        await c.query(
          `UPDATE ledger_stats
           SET value = value + $1::bigint, updated_at = now()
           WHERE asset_id=$2::uuid AND name='circulating_supply'`,
          [reward.toString(), asset.id],
        );

        // INSERT ledger_events + propagate event_seq to the two sidecar
        // tables in a single round-trip via data-modifying CTEs.
        // `inserted.asset_id` is kept as uuid here so the upd_claim CTE
        // can JOIN against ledger_mint_claims.asset_id (also uuid). The
        // text cast happens in the final SELECT projection only.
        const insertedEvent = await c.query<LedgerEventRow>(
          `WITH inserted AS (
             INSERT INTO ledger_events(
               asset_id, id, event_type, actor_pubkey, amount, challenge_id, solution_nonce,
               client_signature_base58, server_sig, created_at
             )
             VALUES($1::uuid, $2, 'MINT', $3, $4, $5, $6, $7, $8, $9)
             RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                       amount, fee_base_units, memo,
                       challenge_id, solution_nonce, idempotency_key,
                       client_signature_base58, server_sig, created_at
           ),
           upd_event_id AS (
             UPDATE ledger_event_ids ids
             SET event_seq = i.event_seq
             FROM inserted i
             WHERE ids.id = i.id
           ),
           upd_claim AS (
             UPDATE ledger_mint_claims c
             SET event_seq = i.event_seq
             FROM inserted i
             WHERE c.asset_id = i.asset_id AND c.challenge_id = i.challenge_id
           )
           SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                  amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                  challenge_id, solution_nonce, idempotency_key,
                  client_signature_base58, server_sig, created_at
           FROM inserted`,
          [
            asset.id,
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
        const event = insertedEvent.rows[0]!;
        await mirrorLedgerEventHot(c, event);
        return { token: { id: eventId, value_base_units: reward.toString(), issued_at: issuedAt.toISOString() } };
      },
      { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'mint' }, 'tx retry') },
    );

    if ('error' in result) {
      const status =
        result.error === 'SUPPLY_EXHAUSTED' ? 410 :
        result.error === 'CHALLENGE_EXPIRED' ? 410 :
        400;
      return reply.code(status).send(result);
    }
    // Successful mint changes the user's balance + activity feed.
    app.invalidateAccount(s.pubkey);
    app.invalidateLedger();
    return result;
  };

  app.post('/mint', handler);
  app.post('/assets/:asset_slug/mint', handler);
}
