import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivityResponse } from '@rpow/shared';

interface ActivityRow {
  id: string | null;
  type: 'mint' | 'send' | 'receive';
  event_seq: string;
  amount: string;
  fee_base_units: string;
  memo: string | null;
  counterparty_pubkey: string | null;
  client_signature_base58: string | null;
  at: Date;
  counterparty_display_name: string | null;
}

const QuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // Optional event-type filter. Applied at the database level so pages
  // stay full and pagination cursors stay correct when filtering. Omitting
  // the param (or 'all') returns every event.
  type: z.enum(['mint', 'send', 'receive', 'all']).optional().default('all'),
});

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const qp = QuerySchema.safeParse(req.query);
    if (!qp.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query params' });

    const { cursor, limit, type } = qp.data;
    // Cache key: first page per (user, type filter) is cached (cursor absent).
    // Subsequent pages are not cached — once an event_seq is in the past it
    // won't change. The `type` filter is part of the key so toggling filter
    // tabs on the UI doesn't return stale cross-filter data.
    const cacheKey = cursor ? null : `${s.pubkey}|${type}`;
    const needsCache = cacheKey !== null;

    const buildPage = async (): Promise<ActivityResponse> => {
      // Fetch balance + events_count from account_balances in a single query.
      const balanceRow = await app.pool.query<{ balance: string; total_count: string }>(
        `SELECT spendable_base_units::text AS balance,
                events_count::text AS total_count
         FROM account_balances
         WHERE pubkey=$1`,
        [s.pubkey],
      );
      const balanceBaseUnits = balanceRow.rows[0]?.balance ?? '0';
      const totalCount = parseInt(balanceRow.rows[0]?.total_count ?? '0', 10);

      // Pagination: cursor is the event_seq of the oldest item on the
      // previous page. We fetch events with event_seq strictly less than
      // the cursor so pages don't overlap.
      const cursorBigInt: bigint | null = cursor ? BigInt(cursor) : null;
      const params: unknown[] = [s.pubkey];
      const filters: string[] = [];
      if (cursorBigInt !== null) {
        params.push(cursorBigInt.toString());
        filters.push(`AND e.event_seq < $${params.length}::bigint`);
      }
      if (type !== 'all') {
        params.push(type);
        filters.push(`AND e.type = $${params.length}`);
      }
      params.push(limit + 1); // +1 to detect if there's a next page
      const limitParam = `$${params.length}`;
      const filterSqlHot = filters.join(' ');

      const recent = await app.pool.query<ActivityRow>(
        `SELECT e.id,
                e.type,
                e.event_seq::text AS event_seq,
                e.amount::text AS amount,
                e.fee_base_units::text AS fee_base_units,
                e.memo,
                e.counterparty_pubkey,
                e.client_signature_base58,
                e.created_at AS at,
                a.display_name AS counterparty_display_name
         FROM account_recent_events e
         LEFT JOIN accounts a ON a.pubkey = e.counterparty_pubkey
         WHERE e.pubkey=$1 ${filterSqlHot}
         ORDER BY e.event_seq DESC
         LIMIT ${limitParam}`,
        params,
      );

      let rows = recent.rows;

      // If hot table doesn't cover the full page (can happen for low-activity
      // accounts or near the cursor boundary), fall back to partitioned history.
      if (rows.length < limit + 1) {
        const oldestHot = rows[rows.length - 1]?.event_seq ?? null;
        const histParams: unknown[] = [s.pubkey];
        const filters: string[] = [];

        if (cursorBigInt !== null) {
          histParams.push(cursorBigInt.toString());
          filters.push(`AND event_seq < $${histParams.length}::bigint`);
        }
        if (oldestHot) {
          histParams.push(oldestHot);
          filters.push(`AND event_seq < $${histParams.length}::bigint`);
        }
        histParams.push(limit + 1 - rows.length);
        const histLimitParam = `$${histParams.length}`;
        const filterSql = filters.join(' ');

        const branches: string[] = [];
        if (type === 'all' || type === 'mint') {
          branches.push(`(SELECT NULL::uuid AS id,
                  'mint' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  '0'::text AS fee_base_units,
                  NULL::text AS memo,
                  NULL::text AS counterparty_pubkey,
                  NULL::text AS client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='MINT' AND actor_pubkey=$1 ${filterSql}
           ORDER BY event_seq DESC
           LIMIT ${histLimitParam})`);
        }
        if (type === 'all' || type === 'send') {
          branches.push(`(SELECT id,
                  'send' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  fee_base_units::text AS fee_base_units,
                  memo,
                  counterparty_pubkey,
                  client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='TRANSFER' AND actor_pubkey=$1 ${filterSql}
           ORDER BY event_seq DESC
           LIMIT ${histLimitParam})`);
        }
        if (type === 'all' || type === 'receive') {
          branches.push(`(SELECT id,
                  'receive' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  '0'::text AS fee_base_units,
                  memo,
                  actor_pubkey AS counterparty_pubkey,
                  client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='TRANSFER' AND counterparty_pubkey=$1 ${filterSql}
           ORDER BY event_seq DESC
           LIMIT ${histLimitParam})`);
        }

        const historicalSql = `
        WITH events AS (
          ${branches.join('\n          UNION ALL\n          ')}
        )
        SELECT events.id::text AS id, events.type, events.event_seq, events.amount,
               events.fee_base_units, events.memo, events.counterparty_pubkey,
               events.client_signature_base58, events.at,
               a.display_name AS counterparty_display_name
        FROM events
        LEFT JOIN accounts a ON a.pubkey = events.counterparty_pubkey
        ORDER BY events.event_seq_sort DESC
        LIMIT ${histLimitParam}`;

        const historical = await app.pool.query<ActivityRow>(historicalSql, histParams);
        rows = [...rows, ...historical.rows];
      }

      // Determine if there's a next page and compute cursor.
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.event_seq : undefined;

      const items = pageRows.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        type: r.type,
        amount_base_units: r.amount,
        ...(r.type === 'send' && r.fee_base_units !== '0' ? { fee_base_units: r.fee_base_units } : {}),
        ...(r.memo ? { memo: r.memo } : {}),
        ...(r.counterparty_pubkey ? { counterparty_pubkey: r.counterparty_pubkey } : {}),
        ...(r.counterparty_display_name ? { counterparty_display_name: r.counterparty_display_name } : {}),
        ...(r.client_signature_base58 ? { client_signature_base58: r.client_signature_base58 } : {}),
        event_seq: r.event_seq,
        at: r.at.toISOString(),
      }));

      return {
        balance_base_units: balanceBaseUnits,
        total_count: totalCount,
        items,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      };
    };

    let body: ActivityResponse;
    if (needsCache) {
      body = (await app.caches.activity.get(cacheKey!, buildPage)) as ActivityResponse;
    } else {
      body = await buildPage();
    }

    reply.header('cache-control', 'private, max-age=0');
    return body;
  });
}
