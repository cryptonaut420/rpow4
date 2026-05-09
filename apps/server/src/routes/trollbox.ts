import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TREASURY_PUBKEY,
  TROLLBOX_BODY_MAX,
  verifyCanonical,
  type TrollboxMessage,
} from '@rpow/shared';
import { withTxRetry } from '../db.js';
import { mirrorLedgerEventHot, type LedgerEventRow } from '../ledger-hot.js';
import { buildCachedJsonResponse, type CachedJsonResponse } from '../cache.js';

const MAX_TROLLBOX_LIMIT = 100;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** DB row shape for building the wire-format message seen in GET /trollbox. */
interface TrollboxMsgRow {
  id: string;
  seq: string;
  author_pubkey: string;
  author_display_name: string | null;
  body: string;
  fee_base_units: string;
  fee_event_id: string;
  created_at: Date;
}

function rowToWireMessage(row: TrollboxMsgRow): TrollboxMessage {
  return {
    id: row.id,
    seq: row.seq,
    author_pubkey: row.author_pubkey,
    ...(row.author_display_name ? { author_display_name: row.author_display_name } : {}),
    body: row.body,
    fee_base_units: row.fee_base_units,
    fee_event_id: row.fee_event_id,
    posted_at: row.created_at.toISOString(),
  };
}

async function selectMessageByIdem(
  db: Pool | PoolClient,
  author: string,
  idem: string,
): Promise<TrollboxMsgRow | null> {
  const r = await db.query<TrollboxMsgRow>(
    `SELECT m.id,
            m.seq::text AS seq,
            m.author_pubkey,
            a.display_name AS author_display_name,
            m.body,
            m.fee_base_units::text AS fee_base_units,
            m.fee_event_id::text AS fee_event_id,
            m.created_at
       FROM trollbox_messages m
       LEFT JOIN accounts a ON a.pubkey = m.author_pubkey
      WHERE m.author_pubkey = $1 AND m.idempotency_key = $2`,
    [author, idem],
  );
  return r.rows[0] ?? null;
}

const PostBody = z.object({
  body: z.string().min(1).max(TROLLBOX_BODY_MAX),
  idempotency_key: z.string().min(8).max(80),
  client_signature_base58: z.string().min(64).max(128),
});

const FeedQuery = z.object({
  cursor: z.string().regex(/^[1-9][0-9]*$/).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TROLLBOX_LIMIT).optional().default(50),
});

interface TrollboxDbRow {
  seq: string;
  id: string;
  author_pubkey: string;
  author_display_name: string | null;
  body: string;
  fee_base_units: string;
  fee_event_id: string;
  created_at: Date;
}

function sendCachedJson(
  reply: FastifyReply,
  cached: CachedJsonResponse,
  ifNoneMatch: string | undefined,
  cacheControl: string,
): FastifyReply {
  reply.header('etag', cached.etag);
  reply.header('cache-control', cacheControl);
  if (ifNoneMatch === cached.etag) return reply.code(304).send();
  reply.header('content-type', JSON_CONTENT_TYPE);
  return reply.send(cached.json);
}

export async function trollboxRoutes(app: FastifyInstance) {
  // ---- GET /trollbox --------------------------------------------------------
  // Public, paginated newest-first feed. ETag-cached so the common
  // first-page poll path returns 304 without rebuilding the response.
  app.get('/trollbox', async (req, reply) => {
    const qp = FeedQuery.safeParse(req.query);
    if (!qp.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query params' });
    }
    const { cursor, limit } = qp.data;
    const cacheKey = `${cursor ?? ''}|${limit}`;

    const cached = await app.caches.trollboxFeed.get(cacheKey, async () => {
      const params: unknown[] = [];
      let cursorFilter = '';
      if (cursor) {
        params.push(cursor);
        cursorFilter = `WHERE m.seq < $${params.length}::bigint`;
      }
      params.push(limit + 1);
      const limitParam = `$${params.length}`;

      const result = await app.pool.query<TrollboxDbRow>(
        `SELECT m.seq::text AS seq,
                m.id,
                m.author_pubkey,
                a.display_name AS author_display_name,
                m.body,
                m.fee_base_units::text AS fee_base_units,
                m.fee_event_id,
                m.created_at
           FROM trollbox_messages m
           LEFT JOIN accounts a ON a.pubkey = m.author_pubkey
           ${cursorFilter}
           ORDER BY m.seq DESC
           LIMIT ${limitParam}`,
        params,
      );

      const totalRow = await app.pool.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='trollbox_message_count'`,
      );
      const totalCount = totalRow.rows[0]?.value ?? '0';

      const hasMore = result.rows.length > limit;
      const page = result.rows.slice(0, limit);
      const last = page[page.length - 1];

      const body = {
        messages: page.map((r) => ({
          id: r.id,
          seq: r.seq,
          author_pubkey: r.author_pubkey,
          ...(r.author_display_name ? { author_display_name: r.author_display_name } : {}),
          body: r.body,
          fee_base_units: r.fee_base_units,
          fee_event_id: r.fee_event_id,
          posted_at: r.created_at.toISOString(),
        })),
        post_fee_base_units: app.config.trollboxPostFeeBaseUnits.toString(),
        body_max: TROLLBOX_BODY_MAX,
        total_count: totalCount,
        ...(hasMore && last ? { next_cursor: last.seq } : {}),
      };
      return buildCachedJsonResponse(body);
    });

    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=2, stale-while-revalidate=10',
    );
  });

  // ---- POST /trollbox -------------------------------------------------------
  // Auth required. Atomically debits the fee from the author, credits
  // the treasury, records a TRANSFER ledger event with memo='trollbox post',
  // and inserts the trollbox row.
  app.post('/trollbox', async (req, reply) => {
    const session = app.readSession(req);
    if (!session) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    }

    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const author = session.pubkey;
    if (author === TREASURY_PUBKEY) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'treasury cannot post' });
    }

    // Trim before hashing/signing/storing so callers can't smuggle hidden
    // whitespace past the length cap or sign one body and store another.
    const body = parsed.data.body.trim();
    if (body.length === 0) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'body cannot be empty after trimming' });
    }
    if (body.length > TROLLBOX_BODY_MAX) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: `body must be at most ${TROLLBOX_BODY_MAX} characters` });
    }

    const idem = parsed.data.idempotency_key;
    const sigBody = { body, idempotency_key: idem };
    const sigOk = verifyCanonical('trollbox.post', sigBody, parsed.data.client_signature_base58, author);
    if (!sigOk) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'trollbox signature does not verify' });
    }

    const fee = app.config.trollboxPostFeeBaseUnits;

    type PostResult =
      | {
          ok: true;
          message_id: string;
          fee_event_id: string;
          fee_base_units: string;
          posted_at: string;
          message: TrollboxMessage;
        }
      | {
          error: 'INSUFFICIENT_BALANCE' | 'BAD_REQUEST';
          message: string;
          status: number;
        };

    let out!: PostResult;
    try {
      out = await withTxRetry<PostResult>(
        app.pool,
        async (c) => {
          // Idempotency: a network retry from the same author with the
          // same key should observe the original row, not double-post.
          const dup = await selectMessageByIdem(c, author, idem);
          if (dup) {
            if (dup.body !== body) {
              return {
                error: 'BAD_REQUEST' as const,
                message: 'idempotency_key reused with a different body',
                status: 409,
              };
            }
            return {
              ok: true as const,
              message_id: dup.id,
              fee_event_id: dup.fee_event_id,
              fee_base_units: dup.fee_base_units,
              posted_at: dup.created_at.toISOString(),
              message: rowToWireMessage(dup),
            };
          }

          // Lock both balance rows in deterministic order so two parallel
          // posters can't deadlock on each other's locks.
          for (const pubkey of [author, TREASURY_PUBKEY].sort()) {
            await c.query(
              `SELECT pg_advisory_xact_lock(hashtext('rpow_account_balance'), hashtext($1))`,
              [pubkey],
            );
          }

          // Debit the fee from the author. events_count +1 so the post
          // shows up in their /activity feed total.
          if (fee > 0n) {
            const debit = await c.query(
              `UPDATE account_balances
                  SET spendable_base_units = spendable_base_units - $2::bigint,
                      sent_base_units = sent_base_units + $2::bigint,
                      events_count = events_count + 1,
                      updated_at = now()
                WHERE pubkey=$1 AND spendable_base_units >= $2::bigint`,
              [author, fee.toString()],
            );
            if (debit.rowCount === 0) {
              return {
                error: 'INSUFFICIENT_BALANCE' as const,
                message: `not enough tokens — ${fee.toString()} base-units required for the post fee`,
                status: 400,
              };
            }
          } else {
            // Fee is disabled; still bump events_count so the post lands
            // in the author's /activity feed for transparency.
            await c.query(
              `UPDATE account_balances
                  SET events_count = events_count + 1,
                      updated_at = now()
                WHERE pubkey=$1`,
              [author],
            );
          }

          // Credit treasury. No events_count bump — treasury has no feed.
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

          const transferId = randomUUID();
          await c.query(`INSERT INTO ledger_event_ids(id) VALUES($1)`, [transferId]);

          const createdAt = new Date();
          const memo = 'trollbox post';

          // CTE: insert ledger event, propagate event_seq, bump
          // transfer_count + total_fees_collected + trollbox_message_count
          // in one round-trip.
          const inserted = await c.query<LedgerEventRow>(
            `WITH inserted AS (
               INSERT INTO ledger_events(
                 id, event_type, actor_pubkey, counterparty_pubkey, amount,
                 fee_base_units, memo, idempotency_key, client_signature_base58, created_at
               )
               VALUES($1,'TRANSFER',$2,$3,$4,0,$5,NULL,$6,$7)
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
             upd_transfer_count AS (
               UPDATE app_counters SET value = value + 1
                WHERE name='transfer_count'
             ),
             upd_fees AS (
               UPDATE app_counters SET value = value + $4::bigint
                WHERE name='total_fees_collected' AND $4::bigint > 0
             ),
             upd_trollbox_count AS (
               UPDATE app_counters SET value = value + 1
                WHERE name='trollbox_message_count'
             )
             SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
                    amount::text AS amount, fee_base_units::text AS fee_base_units, memo,
                    challenge_id, solution_nonce, idempotency_key,
                    client_signature_base58, server_sig, created_at
               FROM inserted`,
            [
              transferId,
              author,
              TREASURY_PUBKEY,
              fee.toString(),
              memo,
              parsed.data.client_signature_base58,
              createdAt,
            ],
          );
          const event = inserted.rows[0]!;
          await mirrorLedgerEventHot(c, event);

          // Track total_transferred via shard. Shard key on the post id
          // spreads writes across shards just like /send does.
          if (fee > 0n) {
            await c.query(
              `UPDATE ledger_stat_shards
                  SET value = value + $1::bigint, updated_at = now()
                WHERE name='total_transferred'
                  AND shard = (mod(hashtext($2)::bigint + 2147483648, 64))::smallint`,
              [fee.toString(), transferId],
            );
          }

          // Record the trollbox row last so a constraint violation
          // (only the author+idem unique index) doesn't leave a stray
          // ledger event behind. The whole tx rolls back together.
          const messageInsert = await c.query(
            `INSERT INTO trollbox_messages(
               author_pubkey, body, fee_base_units, fee_event_id,
               idempotency_key, client_signature_base58, created_at
             )
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              author,
              body,
              fee.toString(),
              transferId,
              idem,
              parsed.data.client_signature_base58,
              createdAt,
            ],
          );
          if (messageInsert.rowCount !== 1) {
            throw new Error('trollbox insert affected unexpected row count');
          }

          const wireRow = await selectMessageByIdem(c, author, idem);
          if (!wireRow) {
            throw new Error('trollbox row missing after insert');
          }

          return {
            ok: true as const,
            message_id: wireRow.id,
            fee_event_id: wireRow.fee_event_id,
            fee_base_units: wireRow.fee_base_units,
            posted_at: wireRow.created_at.toISOString(),
            message: rowToWireMessage(wireRow),
          };
        },
        { onRetry: (err, attempt) => app.log.warn({ err, attempt, route: 'trollbox' }, 'tx retry') },
      );
    } catch (e: unknown) {
      // Concurrent duplicate (author, idempotency_key) inserts: re-read
      // and return the canonical row.
      const code = (e as { code?: string } | null)?.code;
      if (code === '23505') {
        const row = await selectMessageByIdem(app.pool, author, idem);
        if (row) {
          if (row.body !== body) {
            return reply.code(409).send({
              error: 'BAD_REQUEST',
              message: 'idempotency_key reused with a different body',
            });
          }
          return reply.send({
            ok: true,
            message_id: row.id,
            fee_event_id: row.fee_event_id,
            fee_base_units: row.fee_base_units,
            posted_at: row.created_at.toISOString(),
            message: rowToWireMessage(row),
          });
        }
      }
      throw e;
    }

    if ('error' in out) {
      return reply.code(out.status).send({ error: out.error, message: out.message });
    }

    // Author balance + activity changed; ledger aggregates + trollbox
    // feed both shift. invalidateLedger already nukes trollboxFeed.
    app.invalidateAccount(author);
    app.invalidateLedger();
    return out;
  });
}
