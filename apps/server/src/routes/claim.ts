import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyCanonical } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.object({
  claim_id: z.string().regex(UUID_RE, 'claim_id must be a UUID'),
  amount_base_units: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, 'positive bigint string')
    .refine((s) => {
      try { return BigInt(s) > 0n && BigInt(s) <= 10n ** 18n; } catch { return false; }
    }, 'amount_base_units must be a positive bigint up to 10^18'),
  memo: z.string().max(64).optional(),
  client_signature_base58: z.string().min(64).max(128),
});

const CancelBody = z.object({
  client_signature_base58: z.string().min(64).max(128),
});

export async function claimRoutes(app: FastifyInstance) {
  // ---- POST /claim -----------------------------------------------------------
  // Session required. Creates a bearer claim token; debits sender immediately.
  // Client generates the claim_id UUID so it can be included in the signed
  // canonical body before the server sees the request.
  app.post('/claim', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const { claim_id, amount_base_units, memo, client_signature_base58 } = parsed.data;
    const sender = s.pubkey;
    const amount = BigInt(amount_base_units);

    // Verify signature over { claim_id, amount_base_units, memo? }
    const sigBody: Record<string, string> = { claim_id, amount_base_units };
    if (memo) sigBody.memo = memo;
    if (!verifyCanonical('claim.create', sigBody, client_signature_base58, sender)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'claim signature does not verify' });
    }

    type CreateResult =
      | { ok: true; created_at: Date }
      | { error: 'DUPLICATE_CLAIM_ID' | 'INSUFFICIENT_BALANCE'; message: string; status: number };

    let out!: CreateResult;
    try {
      out = await withTxRetry<CreateResult>(
        app.pool,
        async (c) => {
          // Advisory lock on sender balance to serialize against concurrent sends.
          await c.query(
            `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
            [sender],
          );

          const debit = await c.query(
            `UPDATE account_balances
             SET spendable_base_units = spendable_base_units - $2::bigint,
                 sent_base_units = sent_base_units + $2::bigint,
                 updated_at = now()
             WHERE pubkey=$1 AND spendable_base_units >= $2::bigint`,
            [sender, amount.toString()],
          );
          if (debit.rowCount === 0) {
            return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
          }

          const createdAt = new Date();
          await c.query(
            `INSERT INTO claim_tokens(id, sender_pubkey, amount_base_units, memo, client_signature_base58, created_at)
             VALUES($1, $2, $3, $4, $5, $6)`,
            [claim_id, sender, amount.toString(), memo ?? null, client_signature_base58, createdAt],
          );

          return { ok: true as const, created_at: createdAt };
        },
        { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'claim.create' }, 'tx retry') },
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'DUPLICATE_CLAIM_ID', message: 'claim_id already exists' });
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    app.invalidateAccount(sender);
    return {
      ok: true,
      claim_id,
      amount_base_units,
      ...(memo ? { memo } : {}),
      created_at: out.created_at.toISOString(),
    };
  });

  // ---- GET /claim (my pending) -----------------------------------------------
  // Session required. Returns the caller's own claims (all states), newest first.
  // Used by the /claim management page to show a list of outstanding tokens.
  app.get('/claim', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { rows } = await app.pool.query<{
      id: string;
      amount_base_units: string;
      memo: string | null;
      state: string;
      created_at: Date;
      redeemed_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `SELECT id::text,
              amount_base_units::text,
              memo,
              state,
              created_at,
              redeemed_at,
              cancelled_at
       FROM claim_tokens
       WHERE sender_pubkey = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [s.pubkey],
    );

    return {
      claims: rows.map((r) => ({
        claim_id: r.id,
        amount_base_units: r.amount_base_units,
        ...(r.memo ? { memo: r.memo } : {}),
        state: r.state,
        created_at: r.created_at.toISOString(),
        ...(r.redeemed_at ? { redeemed_at: r.redeemed_at.toISOString() } : {}),
        ...(r.cancelled_at ? { cancelled_at: r.cancelled_at.toISOString() } : {}),
      })),
    };
  });

  // ---- GET /claim/:id --------------------------------------------------------
  // Public. Returns amount, memo, and state for a claim — enough to show a
  // preview on the redemption page before the user signs in.
  // Does NOT reveal the sender's pubkey to unauthenticated callers.
  app.get('/claim/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'claim not found' });
    }

    const { rows } = await app.pool.query<{
      amount_base_units: string;
      memo: string | null;
      state: string;
      created_at: Date;
      redeemed_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `SELECT amount_base_units::text,
              memo,
              state,
              created_at,
              redeemed_at,
              cancelled_at
       FROM claim_tokens
       WHERE id = $1::uuid`,
      [id],
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'claim not found' });
    }
    const r = rows[0]!;

    reply.header('cache-control', 'public, max-age=2, stale-while-revalidate=5');
    return {
      claim_id: id,
      amount_base_units: r.amount_base_units,
      ...(r.memo ? { memo: r.memo } : {}),
      state: r.state,
      created_at: r.created_at.toISOString(),
      ...(r.redeemed_at ? { redeemed_at: r.redeemed_at.toISOString() } : {}),
      ...(r.cancelled_at ? { cancelled_at: r.cancelled_at.toISOString() } : {}),
    };
  });

  // ---- POST /claim/:id/redeem ------------------------------------------------
  // Session required. Any authenticated user can redeem a pending claim.
  // Atomically: marks redeemed, credits redeemer, inserts a TRANSFER ledger event.
  app.post('/claim/:id/redeem', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'claim not found' });
    }

    const redeemer = s.pubkey;

    type RedeemResult =
      | { ok: true; amount_base_units: string; transfer_id: string; redeemed_at: string }
      | { error: string; message: string; status: number };

    const out = await withTxRetry<RedeemResult>(
      app.pool,
      async (c) => {
        // Lock the claim row first (FOR UPDATE) so concurrent redemptions serialize.
        const claimRow = await c.query<{
          id: string;
          sender_pubkey: string;
          amount_base_units: string;
          memo: string | null;
          state: string;
          client_signature_base58: string;
        }>(
          `SELECT id::text, sender_pubkey, amount_base_units::text, memo, state, client_signature_base58
           FROM claim_tokens
           WHERE id = $1::uuid
           FOR UPDATE`,
          [id],
        );

        if (claimRow.rows.length === 0) {
          return { error: 'NOT_FOUND', message: 'claim not found', status: 404 };
        }
        const claim = claimRow.rows[0]!;

        if (claim.state !== 'pending') {
          const code = claim.state === 'redeemed' ? 'ALREADY_REDEEMED' : 'CLAIM_CANCELLED';
          return { error: code, message: `claim is ${claim.state}`, status: 409 };
        }

        if (claim.sender_pubkey === redeemer) {
          return { error: 'BAD_REQUEST', message: 'sender cannot redeem their own claim', status: 400 };
        }

        const amount = BigInt(claim.amount_base_units);
        const sender = claim.sender_pubkey;
        const redeemedAt = new Date();

        // Lock both balance rows in consistent order to prevent deadlocks.
        for (const pubkey of [sender, redeemer].sort()) {
          await c.query(
            `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
            [pubkey],
          );
        }

        // Ensure redeemer account exists (lazy-create like /send).
        const recipientInsert = await c.query<{ pubkey: string }>(
          `INSERT INTO accounts(pubkey) VALUES($1)
           ON CONFLICT (pubkey) DO NOTHING
           RETURNING pubkey`,
          [redeemer],
        );
        if (recipientInsert.rows[0]) {
          await c.query(
            `UPDATE ledger_stats SET value = value + 1, updated_at = now()
             WHERE name='user_count'`,
          );
        }

        // Credit redeemer.
        await c.query(
          `INSERT INTO account_balances(pubkey, spendable_base_units, received_base_units, events_count, updated_at)
           VALUES($1, $2, $2, 1, now())
           ON CONFLICT (pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
             events_count = account_balances.events_count + 1,
             updated_at = now()`,
          [redeemer, amount.toString()],
        );

        // Bump sender's events_count (they "sent" this at create time but the
        // event is only created now; bump here to keep total_count in sync).
        await c.query(
          `UPDATE account_balances SET events_count = events_count + 1, updated_at = now()
           WHERE pubkey = $1`,
          [sender],
        );

        const transferId = randomUUID();
        await c.query(`INSERT INTO ledger_event_ids(id) VALUES($1)`, [transferId]);

        // TRANSFER ledger event — sender is actor, redeemer is counterparty.
        const insertedEvent = await c.query<LedgerEventRow>(
          `WITH inserted AS (
             INSERT INTO ledger_events(
               id, event_type, actor_pubkey, counterparty_pubkey, amount,
               fee_base_units, memo, idempotency_key, client_signature_base58, created_at
             )
             VALUES($1::uuid,'TRANSFER',$2,$3,$4,0,$5,'claim:'||$1::text,$6,$7)
             RETURNING event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                       amount, fee_base_units, memo, challenge_id, solution_nonce,
                       idempotency_key, client_signature_base58, server_sig, created_at
           ),
           upd_event_id AS (
             UPDATE ledger_event_ids ids
             SET event_seq = i.event_seq
             FROM inserted i
             WHERE ids.id = i.id
           ),
           upd_transfer_count AS (
             UPDATE app_counters SET value = value + 1
             WHERE name='transfer_count'
           )
           SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                  amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                  challenge_id, solution_nonce, idempotency_key,
                  client_signature_base58, server_sig, created_at
           FROM inserted`,
          [transferId, sender, redeemer, amount.toString(), claim.memo ?? null, claim.client_signature_base58, redeemedAt],
        );

        const event = insertedEvent.rows[0]!;
        await mirrorLedgerEventHot(c, event);

        // Update stat shards for total_transferred.
        await c.query(
          `UPDATE ledger_stat_shards
           SET value = value + $1::bigint, updated_at = now()
           WHERE name='total_transferred'
             AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
          [amount.toString(), transferId],
        );

        // Mark the claim as redeemed.
        await c.query(
          `UPDATE claim_tokens
           SET state='redeemed', redeemer_pubkey=$2, transfer_event_id=$3, redeemed_at=$4
           WHERE id=$1::uuid`,
          [id, redeemer, transferId, redeemedAt],
        );

        return {
          ok: true as const,
          amount_base_units: amount.toString(),
          transfer_id: transferId,
          redeemed_at: redeemedAt.toISOString(),
        };
      },
      { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'claim.redeem' }, 'tx retry') },
    );

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    const { transfer_id, ...rest } = out;
    // Invalidate both parties and public ledger caches.
    const claimRow = await app.pool.query<{ sender_pubkey: string }>(
      `SELECT sender_pubkey FROM claim_tokens WHERE id=$1::uuid`,
      [id],
    );
    const sender = claimRow.rows[0]?.sender_pubkey;
    if (sender) app.invalidateAccount(sender);
    app.invalidateAccount(redeemer);
    app.invalidateLedger();

    return { ok: true, transfer_id, ...rest };
  });

  // ---- POST /claim/:id/cancel ------------------------------------------------
  // Session required (sender only). Refunds the locked amount to the sender.
  // Requires a signature over canonicalMessage('claim.cancel', { claim_id }).
  app.post('/claim/:id/cancel', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'claim not found' });
    }

    const parsed = CancelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const { client_signature_base58 } = parsed.data;
    const caller = s.pubkey;

    // Verify cancellation signature before touching the DB.
    if (!verifyCanonical('claim.cancel', { claim_id: id }, client_signature_base58, caller)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'cancel signature does not verify' });
    }

    type CancelResult =
      | { ok: true; amount_base_units: string; cancelled_at: string }
      | { error: string; message: string; status: number };

    const out = await withTxRetry<CancelResult>(
      app.pool,
      async (c) => {
        const claimRow = await c.query<{
          sender_pubkey: string;
          amount_base_units: string;
          state: string;
        }>(
          `SELECT sender_pubkey, amount_base_units::text, state
           FROM claim_tokens
           WHERE id = $1::uuid
           FOR UPDATE`,
          [id],
        );

        if (claimRow.rows.length === 0) {
          return { error: 'NOT_FOUND', message: 'claim not found', status: 404 };
        }
        const claim = claimRow.rows[0]!;

        if (claim.sender_pubkey !== caller) {
          return { error: 'FORBIDDEN', message: 'only the sender can cancel a claim', status: 403 };
        }
        if (claim.state !== 'pending') {
          const code = claim.state === 'redeemed' ? 'ALREADY_REDEEMED' : 'ALREADY_CANCELLED';
          return { error: code, message: `claim is already ${claim.state}`, status: 409 };
        }

        const amount = BigInt(claim.amount_base_units);
        const cancelledAt = new Date();

        // Advisory lock on sender's balance.
        await c.query(
          `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
          [caller],
        );

        // Refund: reverse the debit made at creation time.
        await c.query(
          `UPDATE account_balances
           SET spendable_base_units = spendable_base_units + $2::bigint,
               sent_base_units = GREATEST(0, sent_base_units - $2::bigint),
               updated_at = now()
           WHERE pubkey = $1`,
          [caller, amount.toString()],
        );

        await c.query(
          `UPDATE claim_tokens SET state='cancelled', cancelled_at=$2 WHERE id=$1::uuid`,
          [id, cancelledAt],
        );

        return {
          ok: true as const,
          amount_base_units: amount.toString(),
          cancelled_at: cancelledAt.toISOString(),
        };
      },
      { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'claim.cancel' }, 'tx retry') },
    );

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    app.invalidateAccount(caller);
    return out;
  });
}
