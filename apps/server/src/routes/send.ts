import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidPubkeyBase58, verifyCanonical } from '@rpow/shared';
import { readSession } from './auth.js';
import { withTx } from '../db.js';

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
});

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.pubkey;
    const { recipient_pubkey: recipient, amount_base_units, idempotency_key: idem, client_signature_base58 } = parsed.data;
    const target = BigInt(amount_base_units);

    if (recipient === sender) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });
    }

    // Per-event client signature: sender signs over the canonical body
    // (excluding the signature field itself). Persisted on the transfer
    // row so the public ledger exposes verifiable per-event sender auth.
    const sigOk = verifyCanonical(
      'transfer',
      { recipient_pubkey: recipient, amount_base_units, idempotency_key: idem },
      client_signature_base58,
      sender,
    );
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'transfer signature does not verify' });
    }

    type SendResult =
      | { ok: true; transferred_base_units: string; recipient_pubkey: string; transfer_id: string }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE'; message: string; status: number };

    let out!: SendResult;
    try {
      out = await withTx<SendResult>(app.pool, async (c) => {
        // Idempotency.
        const dup = await c.query<{ id: string; recipient_pubkey: string; amount: string }>(
          `SELECT id, counterparty_pubkey AS recipient_pubkey, amount::text AS amount
           FROM ledger_events
           WHERE event_type='TRANSFER' AND idempotency_key=$1`,
          [idem],
        );
        if (dup.rows[0]) {
          if (dup.rows[0].recipient_pubkey !== recipient || BigInt(dup.rows[0].amount) !== target) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return {
            ok: true as const,
            transferred_base_units: dup.rows[0].amount,
            recipient_pubkey: dup.rows[0].recipient_pubkey,
            transfer_id: dup.rows[0].id,
          };
        }

        for (const pubkey of [sender, recipient].sort()) {
          await c.query(
            `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
            [pubkey],
          );
        }

        const debit = await c.query(
          `UPDATE account_balances
           SET spendable_base_units = spendable_base_units - $2::bigint,
               sent_base_units = sent_base_units + $2::bigint,
               updated_at = now()
           WHERE pubkey=$1 AND spendable_base_units >= $2::bigint`,
          [sender, target.toString()],
        );
        if (debit.rowCount === 0) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
        }

        // Lazily create the recipient account so /me works on first sign-in.
        // No "pending" flow: a pubkey is self-issued, so any address is a
        // valid recipient — they just have to sign in once to see their
        // tokens.
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

        const transferId = randomUUID();
        const createdAt = new Date();

        await c.query(
          `INSERT INTO account_balances(pubkey, spendable_base_units, received_base_units, updated_at)
           VALUES($1, $2, $2, now())
           ON CONFLICT (pubkey) DO UPDATE SET
             spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
             received_base_units = account_balances.received_base_units + EXCLUDED.received_base_units,
             updated_at = now()`,
          [recipient, target.toString()],
        );

        await c.query(
          `UPDATE ledger_stat_shards
           SET value = value + $1::bigint, updated_at = now()
           WHERE name='total_transferred'
             AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
          [target.toString(), idem],
        );

        await c.query(
          `INSERT INTO ledger_events(
             id, event_type, actor_pubkey, counterparty_pubkey, amount,
             idempotency_key, client_signature_base58, created_at
           )
           VALUES($1,'TRANSFER',$2,$3,$4,$5,$6,$7)`,
          [transferId, sender, recipient, target.toString(), idem, client_signature_base58, createdAt],
        );

        return {
          ok: true as const,
          transferred_base_units: target.toString(),
          recipient_pubkey: recipient,
          transfer_id: transferId,
        };
      });
    } catch (e: any) {
      // Concurrent duplicate-idempotency-key inserts: re-read and return
      // the canonical row.
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_pubkey: string; amount: string }>(
          `SELECT id, counterparty_pubkey AS recipient_pubkey, amount::text AS amount
           FROM ledger_events
           WHERE event_type='TRANSFER' AND idempotency_key=$1`,
          [idem],
        );
        if (tx.rows[0]) {
          return reply.send({
            ok: true,
            transferred_base_units: tx.rows[0].amount,
            recipient_pubkey: tx.rows[0].recipient_pubkey,
            transfer_id: tx.rows[0].id,
          });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });
}
