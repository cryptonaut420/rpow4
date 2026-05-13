import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCachedJsonResponse, type CachedJsonResponse } from '../cache.js';
import type {
  ExplorerFeedResponse,
  ExplorerTxResponse,
  ExplorerAccountResponse,
} from '@rpow/shared';
import { resolveAsset } from '../assets.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map the database's uppercase event_type onto the wire-format type used
 * by the explorer feed / tx detail. The wire types intentionally stay
 * narrow ('mint' | 'transfer' | 'burn' | 'genesis_allocation') so the UI
 * can branch on a single string.
 */
function wireTypeFromEvent(eventType: string): 'mint' | 'transfer' | 'burn' | 'genesis_allocation' {
  switch (eventType) {
    case 'MINT': return 'mint';
    case 'BURN': return 'burn';
    case 'GENESIS_ALLOCATION': return 'genesis_allocation';
    default: return 'transfer';
  }
}

const FeedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  /**
   * Omit or `all` — show every type. `mint` / `transfer` / `burn` /
   * `genesis_allocation` restrict the feed. `genesis_allocation` is
   * mostly relevant for newly-launched assets that seeded a founder
   * allocation; `burn` is the launch fee for the default RPOW4.0 asset.
   */
  type: z.enum(['all', 'mint', 'transfer', 'burn', 'genesis_allocation']).optional().default('all'),
});

const AccountQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  /** Omit or `all` — show everything. Otherwise restricts the items list. */
  type: z.enum(['all', 'mint', 'send', 'receive', 'burn', 'genesis']).optional().default('all'),
});

function sendCachedJson(
  reply: FastifyReply,
  cached: CachedJsonResponse,
  ifNoneMatch: string | undefined,
  cacheControl: string,
): FastifyReply {
  reply.header('etag', cached.etag);
  reply.header('cache-control', cacheControl);
  if (ifNoneMatch === cached.etag) {
    return reply.code(304).send();
  }
  reply.header('content-type', JSON_CONTENT_TYPE);
  return reply.send(cached.json);
}

export async function explorerRoutes(app: FastifyInstance) {
  // ---- GET /explorer/feed ---------------------------------------------------
  // Public paginated network event feed with display names.
  // Cached per cursor+limit key; cleared on new events via invalidateLedger().
  const feedHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    const qp = FeedQuerySchema.safeParse(req.query);
    if (!qp.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query params' });
    }
    const { cursor, limit, type: feedType } = qp.data;
    const cacheKey = `${asset.id}|${cursor ?? ''}|${limit}|${feedType}`;
    const ifNoneMatch = (req.headers as Record<string, string | undefined>)['if-none-match'];

    const cached = await app.caches.explorerFeed.get(cacheKey, async () => {
      const cursorFilter = cursor ? `AND e.event_seq < $2::bigint` : '';
      const typeClause =
        feedType === 'mint'
          ? `AND e.event_type = 'MINT'`
          : feedType === 'transfer'
            ? `AND e.event_type = 'TRANSFER'`
            : feedType === 'burn'
              ? `AND e.event_type = 'BURN'`
              : feedType === 'genesis_allocation'
                ? `AND e.event_type = 'GENESIS_ALLOCATION'`
                : '';
      const params: unknown[] = [asset.id];
      if (cursor) params.push(cursor);
      params.push(limit + 1);
      const limitParam = `$${params.length}`;

      const result = await app.pool.query<{
        event_seq: string;
        id: string;
        event_type: string;
        actor_pubkey: string;
        actor_display_name: string | null;
        counterparty_pubkey: string | null;
        counterparty_display_name: string | null;
        amount: string;
        fee_base_units: string;
        memo: string | null;
        created_at: Date;
      }>(
        `SELECT e.event_seq::text,
                e.id::text,
                e.event_type,
                e.actor_pubkey,
                a1.display_name AS actor_display_name,
                e.counterparty_pubkey,
                a2.display_name AS counterparty_display_name,
                e.amount::text AS amount,
                e.fee_base_units::text,
                e.memo,
                e.created_at
         FROM ledger_recent_events e
         LEFT JOIN accounts a1 ON a1.pubkey = e.actor_pubkey
         LEFT JOIN accounts a2 ON a2.pubkey = e.counterparty_pubkey
         WHERE e.asset_id = $1::uuid
         ${cursorFilter}
         ${typeClause}
         ORDER BY e.event_seq DESC
         LIMIT ${limitParam}`,
        params,
      );

      const rows = result.rows;
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      const body: ExplorerFeedResponse = {
        events: pageRows.map((r) => ({
          event_seq: r.event_seq,
          id: r.id,
          type: wireTypeFromEvent(r.event_type),
          actor_pubkey: r.actor_pubkey,
          ...(r.actor_display_name ? { actor_display_name: r.actor_display_name } : {}),
          ...(r.counterparty_pubkey ? { counterparty_pubkey: r.counterparty_pubkey } : {}),
          ...(r.counterparty_display_name ? { counterparty_display_name: r.counterparty_display_name } : {}),
          amount_base_units: r.amount,
          fee_base_units: r.fee_base_units,
          ...(r.memo ? { memo: r.memo } : {}),
          at: r.created_at.toISOString(),
        })),
        ...(hasMore ? { next_cursor: pageRows[pageRows.length - 1]?.event_seq } : {}),
      };

      return buildCachedJsonResponse(body);
    });

    return sendCachedJson(reply, cached, ifNoneMatch, 'public, max-age=3, stale-while-revalidate=15');
  };
  app.get('/explorer/feed', feedHandler);
  app.get('/assets/:asset_slug/explorer/feed', feedHandler);

  // ---- GET /explorer/tx/:id -------------------------------------------------
  // Public immutable transaction detail by UUID.
  // Long TTL cache — txs are immutable once confirmed.
  const txHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    const { id } = req.params as { id: string };
    if (!UUID_PATTERN.test(id)) {
      return reply.code(404).send({ error: 'BAD_REQUEST', message: 'invalid transaction id format' });
    }

    const ifNoneMatch = (req.headers as Record<string, string | undefined>)['if-none-match'];

    const cached = await app.caches.explorerTx.get(`${asset.id}|${id}`, async () => {
      // ledger_event_ids maps UUID → event_seq for O(1) lookup, then
      // the JOIN to ledger_events uses the partition key (event_seq) directly.
      const result = await app.pool.query<{
        event_seq: string;
        id: string;
        event_type: string;
        actor_pubkey: string;
        actor_display_name: string | null;
        counterparty_pubkey: string | null;
        counterparty_display_name: string | null;
        amount: string;
        fee_base_units: string;
        memo: string | null;
        challenge_id: string | null;
        client_signature_base58: string | null;
        created_at: Date;
      }>(
        `SELECT e.event_seq::text,
                e.id::text,
                e.event_type,
                e.actor_pubkey,
                a1.display_name AS actor_display_name,
                e.counterparty_pubkey,
                a2.display_name AS counterparty_display_name,
                e.amount::text AS amount,
                e.fee_base_units::text,
                e.memo,
                e.challenge_id,
                e.client_signature_base58,
                e.created_at
         FROM ledger_event_ids i
         JOIN ledger_events e ON e.event_seq = i.event_seq
         LEFT JOIN accounts a1 ON a1.pubkey = e.actor_pubkey
         LEFT JOIN accounts a2 ON a2.pubkey = e.counterparty_pubkey
         WHERE i.id = $1::uuid AND i.asset_id=$2::uuid`,
        [id, asset.id],
      );

      if (result.rows.length === 0) return null;
      const r = result.rows[0]!;

      const body: ExplorerTxResponse = {
        event_seq: r.event_seq,
        id: r.id,
        type: wireTypeFromEvent(r.event_type),
        actor_pubkey: r.actor_pubkey,
        ...(r.actor_display_name ? { actor_display_name: r.actor_display_name } : {}),
        ...(r.counterparty_pubkey ? { counterparty_pubkey: r.counterparty_pubkey } : {}),
        ...(r.counterparty_display_name ? { counterparty_display_name: r.counterparty_display_name } : {}),
        amount_base_units: r.amount,
        fee_base_units: r.fee_base_units,
        ...(r.memo ? { memo: r.memo } : {}),
        ...(r.challenge_id ? { challenge_id: r.challenge_id } : {}),
        ...(r.client_signature_base58 ? { client_signature_base58: r.client_signature_base58 } : {}),
        at: r.created_at.toISOString(),
      };

      return buildCachedJsonResponse(body);
    });

    if (cached === null) {
      return reply.code(404).send({ error: 'BAD_REQUEST', message: 'transaction not found' });
    }

    return sendCachedJson(reply, cached, ifNoneMatch, 'public, max-age=3600, immutable');
  };
  app.get('/explorer/tx/:id', txHandler);
  app.get('/assets/:asset_slug/explorer/tx/:id', txHandler);

  // ---- GET /explorer/account/:pubkey ----------------------------------------
  // Public account view: summary stats + paginated event history.
  // First-page responses cached per pubkey; cleared on balance changes.
  const accountHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    const { pubkey } = req.params as { pubkey: string };

    const qp = AccountQuerySchema.safeParse(req.query);
    if (!qp.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query params' });
    }
    const { cursor, limit, type: itemType } = qp.data;

    // Each filter variant has a distinct shape, so include it in the
    // first-page cache key. Cursor pages skip the cache as before.
    const cacheKey = cursor ? null : `${asset.id}|${pubkey}|${itemType}`;

    const buildPage = async (): Promise<ExplorerAccountResponse | null> => {
      // LEFT JOIN account_balances so a known account with no balance row
      // for this asset returns a zero summary instead of 404. If the pubkey
      // is unknown to the platform entirely, ac.pubkey is null and we 404.
      const acctResult = await app.pool.query<{
        known_pubkey: string | null;
        display_name: string | null;
        spendable: string | null;
        minted: string | null;
        sent: string | null;
        received: string | null;
        blocks_mined: string | null;
        events_count: string | null;
      }>(
        `SELECT ac.pubkey AS known_pubkey,
                ac.display_name,
                ab.spendable_base_units::text AS spendable,
                ab.minted_base_units::text AS minted,
                ab.sent_base_units::text AS sent,
                ab.received_base_units::text AS received,
                ab.blocks_mined::text,
                ab.events_count::text
         FROM accounts ac
         LEFT JOIN account_balances ab
           ON ab.pubkey = ac.pubkey AND ab.asset_id = $1::uuid
         WHERE ac.pubkey = $2`,
        [asset.id, pubkey],
      );

      if (acctResult.rows.length === 0) return null;
      const acctRow = acctResult.rows[0]!;
      const acct = {
        display_name: acctRow.display_name,
        spendable: acctRow.spendable ?? '0',
        minted: acctRow.minted ?? '0',
        sent: acctRow.sent ?? '0',
        received: acctRow.received ?? '0',
        blocks_mined: acctRow.blocks_mined ?? '0',
        events_count: acctRow.events_count ?? '0',
      };

      const cursorBigInt: bigint | null = cursor ? BigInt(cursor) : null;
      const params: unknown[] = [asset.id, pubkey];
      const filters: string[] = [];
      if (cursorBigInt !== null) {
        params.push(cursorBigInt.toString());
        filters.push(`AND e.event_seq < $${params.length}::bigint`);
      }
      if (itemType !== 'all') {
        params.push(itemType);
        filters.push(`AND e.type = $${params.length}::text`);
      }
      params.push(limit + 1);
      const limitParam = `$${params.length}`;
      const filterSqlHot = filters.join(' ');

      const recent = await app.pool.query<{
        id: string | null;
        type: 'mint' | 'send' | 'receive' | 'burn' | 'genesis';
        event_seq: string;
        amount: string;
        fee_base_units: string;
        memo: string | null;
        counterparty_pubkey: string | null;
        counterparty_display_name: string | null;
        at: Date;
      }>(
        `SELECT e.id::text AS id,
                e.type,
                e.event_seq::text AS event_seq,
                e.amount::text AS amount,
                e.fee_base_units::text AS fee_base_units,
                e.memo,
                e.counterparty_pubkey,
                a.display_name AS counterparty_display_name,
                e.created_at AS at
         FROM account_recent_events e
         LEFT JOIN accounts a ON a.pubkey = e.counterparty_pubkey
         WHERE e.asset_id = $1::uuid AND e.pubkey = $2 ${filterSqlHot}
         ORDER BY e.event_seq DESC
         LIMIT ${limitParam}`,
        params,
      );

      let rows = recent.rows;

      // Fall back to partitioned history if hot table doesn't fill the page.
      if (rows.length < limit + 1) {
        const oldestHot = rows[rows.length - 1]?.event_seq ?? null;
        const histParams: unknown[] = [asset.id, pubkey];
        const histFilters: string[] = [];

        if (cursorBigInt !== null) {
          histParams.push(cursorBigInt.toString());
          histFilters.push(`AND event_seq < $${histParams.length}::bigint`);
        }
        if (oldestHot) {
          histParams.push(oldestHot);
          histFilters.push(`AND event_seq < $${histParams.length}::bigint`);
        }
        histParams.push(limit + 1 - rows.length);
        const histLimitParam = `$${histParams.length}`;
        const filterSql = histFilters.join(' ');

        // Only include the union branches the requested filter cares
        // about. The query is cheaper (fewer index probes) AND keeps the
        // post-union LIMIT from being dominated by irrelevant branches.
        // Note: 'mint' lumps in GENESIS_ALLOCATION rows so the
        // newly-launched-asset founder bonus surfaces under the same
        // "mints" filter the UI already exposes; choosing 'genesis'
        // narrows to just those founder rows.
        const wantMint = itemType === 'all' || itemType === 'mint';
        const wantSend = itemType === 'all' || itemType === 'send';
        const wantReceive = itemType === 'all' || itemType === 'receive';
        const wantBurn = itemType === 'all' || itemType === 'burn';
        const wantGenesis = itemType === 'genesis';
        const branches: string[] = [];
        if (wantMint) {
          branches.push(`(SELECT NULL::uuid AS id,
                    'mint' AS type,
                    event_seq,
                    amount,
                    0::bigint AS fee_base_units,
                    NULL::text AS memo,
                    NULL::text AS counterparty_pubkey,
                    created_at
             FROM ledger_events
             WHERE asset_id=$1::uuid AND event_type IN ('MINT','GENESIS_ALLOCATION') AND actor_pubkey=$2 ${filterSql}
             ORDER BY event_seq DESC LIMIT ${histLimitParam})`);
        }
        if (wantGenesis) {
          branches.push(`(SELECT id,
                    'genesis' AS type,
                    event_seq,
                    amount,
                    0::bigint AS fee_base_units,
                    memo,
                    NULL::text AS counterparty_pubkey,
                    created_at
             FROM ledger_events
             WHERE asset_id=$1::uuid AND event_type='GENESIS_ALLOCATION' AND actor_pubkey=$2 ${filterSql}
             ORDER BY event_seq DESC LIMIT ${histLimitParam})`);
        }
        if (wantBurn) {
          branches.push(`(SELECT id,
                    'burn' AS type,
                    event_seq,
                    amount,
                    0::bigint AS fee_base_units,
                    memo,
                    NULL::text AS counterparty_pubkey,
                    created_at
             FROM ledger_events
             WHERE asset_id=$1::uuid AND event_type='BURN' AND actor_pubkey=$2 ${filterSql}
             ORDER BY event_seq DESC LIMIT ${histLimitParam})`);
        }
        if (wantSend) {
          branches.push(`(SELECT id,
                    'send' AS type,
                    event_seq,
                    amount,
                    fee_base_units,
                    memo,
                    counterparty_pubkey,
                    created_at
             FROM ledger_events
             WHERE asset_id=$1::uuid AND event_type='TRANSFER' AND actor_pubkey=$2 ${filterSql}
             ORDER BY event_seq DESC LIMIT ${histLimitParam})`);
        }
        if (wantReceive) {
          branches.push(`(SELECT id,
                    'receive' AS type,
                    event_seq,
                    amount,
                    0::bigint AS fee_base_units,
                    memo,
                    actor_pubkey AS counterparty_pubkey,
                    created_at
             FROM ledger_events
             WHERE asset_id=$1::uuid AND event_type='TRANSFER' AND counterparty_pubkey=$2 ${filterSql}
             ORDER BY event_seq DESC LIMIT ${histLimitParam})`);
        }

        if (branches.length > 0) {
          const historical = await app.pool.query<{
            id: string | null;
            type: 'mint' | 'send' | 'receive' | 'burn' | 'genesis';
            event_seq: string;
            amount: string;
            fee_base_units: string;
            memo: string | null;
            counterparty_pubkey: string | null;
            counterparty_display_name: string | null;
            at: Date;
          }>(
            `WITH events AS (
              ${branches.join('\n              UNION ALL\n              ')}
             )
             SELECT ev.id::text AS id,
                    ev.type::text AS type,
                    ev.event_seq::text AS event_seq,
                    ev.amount::text AS amount,
                    ev.fee_base_units::text AS fee_base_units,
                    ev.memo,
                    ev.counterparty_pubkey,
                    a.display_name AS counterparty_display_name,
                    ev.created_at AS at
             FROM events ev
             LEFT JOIN accounts a ON a.pubkey = ev.counterparty_pubkey
             ORDER BY ev.event_seq DESC
             LIMIT ${histLimitParam}`,
            histParams,
          );

          rows = [...rows, ...historical.rows];
        }
      }

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.event_seq : undefined;

      return {
        pubkey,
        ...(acct.display_name ? { display_name: acct.display_name } : {}),
        spendable_base_units: acct.spendable,
        minted_base_units: acct.minted,
        sent_base_units: acct.sent,
        received_base_units: acct.received,
        blocks_mined: acct.blocks_mined,
        total_count: parseInt(acct.events_count, 10),
        items: pageRows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          event_seq: r.event_seq,
          type: r.type,
          amount_base_units: r.amount,
          ...(r.type === 'send' && r.fee_base_units !== '0' ? { fee_base_units: r.fee_base_units } : {}),
          ...(r.memo ? { memo: r.memo } : {}),
          ...(r.counterparty_pubkey ? { counterparty_pubkey: r.counterparty_pubkey } : {}),
          ...(r.counterparty_display_name ? { counterparty_display_name: r.counterparty_display_name } : {}),
          at: r.at.toISOString(),
        })),
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      };
    };

    let body: ExplorerAccountResponse | null;
    if (cacheKey) {
      body = (await app.caches.explorerAccount.get(cacheKey, buildPage)) as ExplorerAccountResponse | null;
    } else {
      body = await buildPage();
    }

    if (body === null) {
      return reply.code(404).send({ error: 'BAD_REQUEST', message: 'account not found' });
    }

    reply.header('cache-control', 'public, max-age=3, stale-while-revalidate=15');
    return body;
  };
  app.get('/explorer/account/:pubkey', accountHandler);
  app.get('/assets/:asset_slug/explorer/account/:pubkey', accountHandler);
}
