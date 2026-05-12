import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildCachedJsonResponse, type CachedJsonResponse } from '../cache.js';
import { resolveAsset, type AssetContext } from '../assets.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const LEADERBOARD_LIMIT = 100;

/**
 * Two leaderboard variants:
 *
 *   sort=balance (default) — order by spendable_base_units DESC, served
 *     by the partial DESC index added in migration 018.
 *
 *   sort=minted           — order by minted_base_units DESC, served by
 *     the partial DESC index added in migration 019.
 *
 * Both share the same response shape and the same `LeaderboardEntry`
 * fields so the client can render either with a single component.
 */
type SortKey = 'balance' | 'minted';

const SORT_COLUMNS: Record<SortKey, string> = {
  balance: 'b.spendable_base_units',
  minted: 'b.minted_base_units',
};

/**
 * Public stats endpoints. Read-only, heavily cached, ETag-aware.
 *
 * /stats/leaderboard returns the top-100 by either spendable balance
 * (default) or lifetime minted base units. Each variant is backed by a
 * partial DESC index, so the query is an index range scan over at most
 * 100 rows regardless of total account count. The result is
 * pre-serialized once per cache window per sort key and reused across
 * requests via `If-None-Match` 304s.
 */
export async function statsRoutes(app: FastifyInstance) {
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

  async function leaderboardCachedResponse(asset: AssetContext, sort: SortKey): Promise<CachedJsonResponse> {
    return app.caches.leaderboard.get(`${asset.id}|${sort}`, async () => {
      const orderColumn = SORT_COLUMNS[sort];
      const filterColumn = orderColumn;
      const { rows } = await app.pool.query<{
        rank: string;
        pubkey: string;
        display_name: string | null;
        spendable_base_units: string;
        minted_base_units: string;
        sent_base_units: string;
        received_base_units: string;
        blocks_mined: string;
      }>(
        `SELECT
           row_number() OVER (ORDER BY ${orderColumn} DESC, b.pubkey)::text AS rank,
           b.pubkey,
           a.display_name,
           b.spendable_base_units::text AS spendable_base_units,
           b.minted_base_units::text     AS minted_base_units,
           b.sent_base_units::text       AS sent_base_units,
           b.received_base_units::text   AS received_base_units,
           b.blocks_mined::text          AS blocks_mined
         FROM account_balances b
         JOIN accounts a ON a.pubkey = b.pubkey
         WHERE b.asset_id=$2::uuid AND ${filterColumn} > 0
         ORDER BY ${orderColumn} DESC, b.pubkey
         LIMIT $1`,
        [LEADERBOARD_LIMIT, asset.id],
      );

      const body = {
        sort,
        asset_id: asset.id,
        asset_slug: asset.slug,
        asset_code: asset.displayCode,
        entries: rows.map((r) => ({
          rank: Number(r.rank),
          pubkey: r.pubkey,
          display_name: r.display_name,
          spendable_base_units: r.spendable_base_units,
          minted_base_units: r.minted_base_units,
          sent_base_units: r.sent_base_units,
          received_base_units: r.received_base_units,
          blocks_mined: r.blocks_mined,
        })),
        generated_at: new Date().toISOString(),
        limit: LEADERBOARD_LIMIT,
      };
      return buildCachedJsonResponse(body);
    });
  }

  const handler = async (req: FastifyRequest<{ Querystring: { sort?: string } }>, reply: FastifyReply) => {
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    const sortRaw = req.query.sort;
    const sort: SortKey =
      sortRaw === 'minted' ? 'minted' :
      (sortRaw === undefined || sortRaw === 'balance') ? 'balance' :
      // Anything else: treat as a 400 so clients get told about typos
      // rather than silently falling back to a different ordering.
      'invalid' as SortKey;
    if ((sort as string) === 'invalid') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'sort must be balance or minted' });
    }
    const cached = await leaderboardCachedResponse(asset, sort);
    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=10, stale-while-revalidate=60',
    );
  };

  app.get('/stats/leaderboard', handler);
  app.get('/assets/:asset_slug/stats/leaderboard', handler);
}
