import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidPubkeyBase58, verifyCanonical, TREASURY_PUBKEY } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { feeAtHalving } from '../schedule.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';

const Body = z.object({
  recipient_pubkey: z.string().refine(isValidPubkeyBase58, { message: 'invalid base58 Ed25519 pubkey' }),
  amount_base_units: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string')
    .refine(
      (s) => {
        try {
          const n = BigInt(s);
          return n > 0n && n <= 10n ** 18n;
        } catch {
          return false;
        }
      },
      'amount_base_units must be a positive bigint up to 10^18',
    ),
  idempotency_key: z.string().min(8).max(80),
  client_signature_base58: z.string().min(64).max(128),
  memo: z.string().max(64).optional(),
});

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.pubkey;
    const {
      recipient_pubkey: recipient,
      amount_base_units,
      idempotency_key: idem,
      client_signature_base58,
      memo,
    } = parsed.data;
    const target = BigInt(amount_base_units);

    if (recipient === sender) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });
    }

    // Per-event client signature: sender signs over the canonical body
    // (excluding the signature field itself). Memo is included when present.
    const sigBody: Record<string, string> = { recipient_pubkey: recipient, amount_base_units, idempotency_key: idem };
    if (memo) sigBody.memo = memo;
    const sigOk = verifyCanonical('transfer', sigBody, client_signature_base58, sender);
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'transfer signature does not verify' });
    }

    type SendResult =
      | { ok: true; transferred_base_units: string; fee_base_units: string; recipient_pubkey: string; transfer_id: string }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE'; message: string; status: number };

    let out!: SendResult;
    try {
      out = await withTxRetry<SendResult>(
        app.pool,
        async (c) => {
          // Idempotency.
          const dup = await c.query<{ id: string; recipient_pubkey: string; amount: string; fee: string }>(
            `SELECT event_id AS id, recipient_pubkey, amount::text AS amount, fee_base_units::text AS fee
             FROM ledger_transfer_idempotency
             WHERE idempotency_key=$1`,
            [idem],
          );
          if (dup.rows[0]) {
            if (dup.rows[0].recipient_pubkey !== recipient || BigInt(dup.rows[0].amount) !== target) {
              return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
            }
            return {
              ok: true as const,
              transferred_base_units: dup.rows[0].amount,
              fee_base_units: dup.rows[0].fee ?? '0',
              recipient_pubkey: dup.rows[0].recipient_pubkey,
              transfer_id: dup.rows[0].id,
            };
          }

          // Read block_height to compute the current halving index and fee.
          // This read happens inside the transaction but before the advisory
          // locks, which is safe: block_height only moves up, so a slightly
          // stale read only means a slightly generous fee tier (never wrong).
          const heightRow = await c.query<{ value: string }>(
            `SELECT value::text FROM app_counters WHERE name='block_height'`,
          );
          const blockHeight = BigInt(heightRow.rows[0]?.value ?? '0');
          const halvingIndex = Number(blockHeight / BigInt(app.config.halvingIntervalBlocks));
          const baseFee = feeAtHalving(app.config.sendBaseFeeBaseUnits, halvingIndex);

          const waiveRow = await c.query<{ waived: boolean }>(
            `SELECT COALESCE(
               (SELECT send_fees_waived FROM accounts WHERE pubkey = $1),
               false
             ) AS waived`,
            [sender],
          );
          const fee = waiveRow.rows[0]?.waived === true ? 0n : baseFee;
          const totalDebit = target + fee;

          for (const pubkey of [sender, recipient].sort()) {
            await c.query(
              `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
              [pubkey],
            );
          }

          const transferId = randomUUID();
          await c.query(
            `INSERT INTO ledger_event_ids(id) VALUES($1)`,
            [transferId],
          );

          await c.query(
            `INSERT INTO ledger_transfer_idempotency(
               idempotency_key, event_id, sender_pubkey, recipient_pubkey, amount, fee_base_units
             )
             VALUES($1,$2,$3,$4,$5,$6)`,
            [idem, transferId, sender, recipient, target.toString(), fee.toString()],
          );

          // Debit amount + fee from sender. events_count +1 for the send event.
          const debit = await c.query(
            `UPDATE account_balances
             SET spendable_base_units = spendable_base_units - $2::bigint,
                 sent_base_units = sent_base_units + $3::bigint,
                 events_count = events_count + 1,
                 updated_at = now()
             WHERE pubkey=$1 AND spendable_base_units >= $2::bigint`,
            [sender, totalDebit.toString(), target.toString()],
          );
          if (debit.rowCount === 0) {
            return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens (including fee)', status: 400 };
          }

          // Lazily create the recipient account so /me works on first sign-in.
          const recipientInsert = await c.query<{ pubkey: string }>(
            `INSERT INTO accounts(pubkey) VALUES($1)
             ON CONFLICT (pubkey) DO NOTHING
             RETURNING pubkey`,
            [recipient],
          );
          if (recipientInsert.rows[0]) {
            await c.query(
              `UPDATE ledger_stats SET value = value + 1, updated_at = now()
               WHERE name='user_count'`,
            );
          }

          const createdAt = new Date();

          // Credit amount to recipient + bump their events_count.
          await c.query(
            `INSERT INTO account_balances(pubkey, spendable_base_units, received_base_units, events_count, updated_at)
             VALUES($1, $2, $2, 1, now())
             ON CONFLICT (pubkey) DO UPDATE SET
               spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
               received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
               events_count = account_balances.events_count + 1,
               updated_at = now()`,
            [recipient, target.toString()],
          );

          // Credit fee to treasury. No events_count on treasury (no activity feed).
          if (fee > 0n) {
            await c.query(
              `INSERT INTO account_balances(pubkey, spendable_base_units, updated_at)
               VALUES($1, $2, now())
               ON CONFLICT (pubkey) DO UPDATE SET
                 spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
                 updated_at = now()`,
              [TREASURY_PUBKEY, fee.toString()],
            );
          }

          await c.query(
            `UPDATE ledger_stat_shards
             SET value = value + $1::bigint, updated_at = now()
             WHERE name='total_transferred'
               AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
            [target.toString(), idem],
          );

          // Single CTE: insert ledger_events + propagate event_seq to
          // sidecar tables + bump transfer_count + bump total_fees_collected.
          const insertedEvent = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 id, event_type, actor_pubkey, counterparty_pubkey, amount,
                 fee_base_units, memo,
                 idempotency_key, client_signature_base58, created_at
               )
               VALUES($1,'TRANSFER',$2,$3,$4,$5,$6,$7,$8,$9)
               RETURNING event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
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
             upd_idem AS (
               UPDATE ledger_transfer_idempotency t
               SET event_seq = i.event_seq
               FROM inserted i
               WHERE t.idempotency_key = i.idempotency_key
             ),
             upd_transfer_count AS (
               UPDATE app_counters
               SET value = value + 1
               WHERE name='transfer_count'
             ),
             upd_fees AS (
               UPDATE app_counters
               SET value = value + $5::bigint
               WHERE name='total_fees_collected' AND $5::bigint > 0
             )
             SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
             FROM inserted`,
            [transferId, sender, recipient, target.toString(), fee.toString(), memo ?? null, idem, client_signature_base58, createdAt],
          );
          const event = insertedEvent.rows[0]!;
          await mirrorLedgerEventHot(c, event);

          return {
            ok: true as const,
            transferred_base_units: target.toString(),
            fee_base_units: fee.toString(),
            recipient_pubkey: recipient,
            transfer_id: transferId,
          };
        },
        { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'send' }, 'tx retry') },
      );
    } catch (e: any) {
      // Concurrent duplicate-idempotency-key inserts: re-read and return
      // the canonical row.
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_pubkey: string; amount: string; fee: string }>(
          `SELECT event_id AS id, recipient_pubkey, amount::text AS amount, fee_base_units::text AS fee
           FROM ledger_transfer_idempotency
           WHERE idempotency_key=$1`,
          [idem],
        );
        if (tx.rows[0]) {
          if (tx.rows[0].recipient_pubkey !== recipient || BigInt(tx.rows[0].amount) !== target) {
            return reply.code(409).send({
              error: 'BAD_REQUEST',
              message: 'idempotency_key reused with different parameters',
            });
          }
          return reply.send({
            ok: true,
            transferred_base_units: tx.rows[0].amount,
            fee_base_units: tx.rows[0].fee ?? '0',
            recipient_pubkey: tx.rows[0].recipient_pubkey,
            transfer_id: tx.rows[0].id,
          });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    // Both sides change: sender's balance/sent + activity, recipient's
    // balance/received + activity.
    app.invalidateAccount(sender);
    app.invalidateAccount(recipient);
    app.invalidateLedger();
    return out;
  });
}
