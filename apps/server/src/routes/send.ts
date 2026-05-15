import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidPubkeyBase58, verifyCanonical, TREASURY_PUBKEY } from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { feeAtHalving } from '../schedule.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import { DEFAULT_ASSET_SLUG, resolveAsset } from '../assets.js';

const Body = z.object({
  asset_id: z.string().uuid().optional(),
  recipient_pubkey: z.string().refine(isValidPubkeyBase58, { message: 'invalid base58 Ed25519 pubkey' }),
  amount_base_units: z
    .string()
    .regex(/^[1-9][0-9]{0,29}$/, 'positive integer as string')
    .refine((s) => {
      try { return BigInt(s) > 0n; } catch { return false; }
    }, 'amount_base_units must be a positive integer'),
  idempotency_key: z.string().min(8).max(80),
  client_signature_base58: z.string().min(64).max(128),
  // Memos render verbatim in /activity, /explorer, and counterparty
  // notifications, so reject ASCII control characters (which would break
  // line-based UIs and may be filtered out by downstream tooling). Surrounding
  // whitespace is trimmed for the same reason.
  memo: z
    .string()
    .max(64)
    .transform((s) => s.trim())
    .refine((s) => !/[\x00-\x1F\x7F]/.test(s), 'memo cannot contain control characters')
    .optional(),
});

export async function sendRoutes(app: FastifyInstance) {
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

    const sigBody: Record<string, string> = { recipient_pubkey: recipient, amount_base_units, idempotency_key: idem };
    if (memo) sigBody.memo = memo;
    const scopedSigBody = { asset_id: asset.id, ...sigBody };
    const sigOk = verifyCanonical(
      'transfer',
      parsed.data.asset_id || asset.slug !== DEFAULT_ASSET_SLUG ? scopedSigBody : sigBody,
      client_signature_base58,
      sender,
    ) || (asset.slug === DEFAULT_ASSET_SLUG && verifyCanonical('transfer', sigBody, client_signature_base58, sender));
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
          const dup = await c.query<{ id: string; recipient_pubkey: string; amount: string; fee: string }>(
            `SELECT event_id AS id, recipient_pubkey, amount::text AS amount, fee_base_units::text AS fee
             FROM ledger_transfer_idempotency
             WHERE asset_id=$1::uuid AND idempotency_key=$2`,
            [asset.id, idem],
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

          const heightRow = await c.query<{ value: string }>(
            `SELECT value::text FROM app_counters WHERE asset_id=$1::uuid AND name='block_height'`,
            [asset.id],
          );
          const blockHeight = BigInt(heightRow.rows[0]?.value ?? '0');
          const halvingIndex = Number(blockHeight / BigInt(app.config.halvingIntervalBlocks));
          const baseFee = asset.systemDefault
            ? feeAtHalving(app.config.sendBaseFeeBaseUnits, halvingIndex)
            : asset.transferFeeBaseUnits;

          const waiveRow = await c.query<{ waived: boolean }>(
            `SELECT COALESCE((SELECT send_fees_waived FROM accounts WHERE pubkey = $1), false) AS waived`,
            [sender],
          );
          const fee = waiveRow.rows[0]?.waived === true ? 0n : baseFee;
          const totalDebit = target + fee;

          for (const pubkey of [sender, recipient].sort()) {
            await c.query(
              `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance:' || $1), hashtext($2))`,
              [asset.id, pubkey],
            );
          }

          const transferId = randomUUID();
          await c.query(`INSERT INTO ledger_event_ids(id, asset_id) VALUES($1, $2::uuid)`, [transferId, asset.id]);
          await c.query(
            `INSERT INTO ledger_transfer_idempotency(
               asset_id, idempotency_key, event_id, sender_pubkey, recipient_pubkey, amount, fee_base_units
             )
             VALUES($1::uuid,$2,$3,$4,$5,$6,$7)`,
            [asset.id, idem, transferId, sender, recipient, target.toString(), fee.toString()],
          );

          const debit = await c.query(
            `UPDATE account_balances
             SET spendable_base_units = spendable_base_units - $3::numeric,
                 sent_base_units = sent_base_units + $4::numeric,
                 events_count = events_count + 1,
                 updated_at = now()
             WHERE asset_id=$1::uuid AND pubkey=$2 AND spendable_base_units >= $3::numeric`,
            [asset.id, sender, totalDebit.toString(), target.toString()],
          );
          if (debit.rowCount === 0) {
            return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens (including fee)', status: 400 };
          }

          await c.query(
            `INSERT INTO accounts(pubkey) VALUES($1)
             ON CONFLICT (pubkey) DO NOTHING`,
            [recipient],
          );

          // Lazy-create the recipient's balance row for this asset and bump
          // per-asset user_count when (asset_id, pubkey) is brand new. The
          // (xmax = 0) RETURNING flag distinguishes insert vs ON CONFLICT
          // update so we keep ledger_stats.user_count consistent with the
          // balance_row_count reconciliation invariant.
          const createdAt = new Date();
          const credit = await c.query<{ was_inserted: boolean }>(
            `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
             VALUES($1::uuid, $2, $3, $3, 1, now())
             ON CONFLICT (asset_id, pubkey) DO UPDATE SET
               spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
               received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
               events_count = account_balances.events_count + 1,
               updated_at = now()
             RETURNING (xmax = 0) AS was_inserted`,
            [asset.id, recipient, target.toString()],
          );
          if (credit.rows[0]?.was_inserted) {
            await c.query(
              `UPDATE ledger_stats SET value = value + 1, updated_at = now()
               WHERE asset_id=$1::uuid AND name='user_count'`,
              [asset.id],
            );
          }

          if (fee > 0n) {
            const treasuryCredit = await c.query<{ was_inserted: boolean }>(
              `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, updated_at)
               VALUES($1::uuid, $2, $3, now())
               ON CONFLICT (asset_id, pubkey) DO UPDATE SET
                 spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
                 updated_at = now()
               RETURNING (xmax = 0) AS was_inserted`,
              [asset.id, TREASURY_PUBKEY, fee.toString()],
            );
            if (treasuryCredit.rows[0]?.was_inserted) {
              await c.query(
                `UPDATE ledger_stats SET value = value + 1, updated_at = now()
                 WHERE asset_id=$1::uuid AND name='user_count'`,
                [asset.id],
              );
            }
          }

          await c.query(
            `UPDATE ledger_stat_shards
             SET value = value + $1::numeric, updated_at = now()
             WHERE asset_id=$3::uuid
               AND name='total_transferred'
               AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
            [target.toString(), idem, asset.id],
          );

          // `inserted.asset_id` stays uuid here so the upd_idem CTE can JOIN
          // against ledger_transfer_idempotency.asset_id (also uuid). The
          // text cast is deferred to the final SELECT projection.
          const insertedEvent = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 asset_id, id, event_type, actor_pubkey, counterparty_pubkey, amount,
                 fee_base_units, memo, idempotency_key, client_signature_base58, created_at
               )
               VALUES($1::uuid,$2,'TRANSFER',$3,$4,$5,$6,$7,$8,$9,$10)
               RETURNING asset_id, event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                         amount, fee_base_units, memo, challenge_id, solution_nonce, idempotency_key,
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
               WHERE t.asset_id = i.asset_id AND t.idempotency_key = i.idempotency_key
             ),
             upd_transfer_count AS (
               UPDATE app_counters SET value = value + 1
               WHERE asset_id=$1::uuid AND name='transfer_count'
             ),
             upd_fees AS (
               UPDATE app_counters SET value = value + $6::numeric
               WHERE asset_id=$1::uuid AND name='total_fees_collected' AND $6::numeric > 0
             )
             SELECT asset_id::text AS asset_id, event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
             FROM inserted`,
            [asset.id, transferId, sender, recipient, target.toString(), fee.toString(), memo ?? null, idem, client_signature_base58, createdAt],
          );
          await mirrorLedgerEventHot(c, insertedEvent.rows[0]!);

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
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_pubkey: string; amount: string; fee: string }>(
          `SELECT event_id AS id, recipient_pubkey, amount::text AS amount, fee_base_units::text AS fee
           FROM ledger_transfer_idempotency
           WHERE asset_id=$1::uuid AND idempotency_key=$2`,
          [asset.id, idem],
        );
        if (tx.rows[0]) {
          if (tx.rows[0].recipient_pubkey !== recipient || BigInt(tx.rows[0].amount) !== target) {
            return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key reused with different parameters' });
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
    app.invalidateAccount(sender);
    app.invalidateAccount(recipient);
    app.invalidateLedger();
    return out;
  };

  app.post('/send', handler);
  app.post('/assets/:asset_slug/send', handler);
}
