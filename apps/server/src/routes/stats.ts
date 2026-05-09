import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildCachedJsonResponse, type CachedJsonResponse } from '../cache.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const LEADERBOARD_LIMIT = 100;

/**
 * Public stats endpoints. Read-only, heavily cached, ETag-aware.
 *
 * /stats/leaderboard returns the top-100 spendable balances. Backed by
 * the partial DESC index added in migration 018, so the query is an
 * index range scan over at most 100 rows regardless of total account
 * count. The result is pre-serialized once per cache window and reused
 * across requests via `If-None-Match` 304s.
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

  async function leaderboardCachedResponse(): Promise<CachedJsonResponse> {
    return app.caches.leaderboard.get('singleton', async () => {
      const { rows } = await app.pool.query<{
        rank: string;
        pubkey: string;
        display_name: string | null;
        spendable_base_units: string;
        minted_base_units: string;
        sent_base_units: string;
        received_base_units: string;
      }>(
        `SELECT
           row_number() OVER ()::text AS rank,
           b.pubkey,
           a.display_name,
           b.spendable_base_units::text AS spendable_base_units,
           b.minted_base_units::text     AS minted_base_units,
           b.sent_base_units::text       AS sent_base_units,
           b.received_base_units::text   AS received_base_units
         FROM account_balances b
         JOIN accounts a ON a.pubkey = b.pubkey
         WHERE b.spendable_base_units > 0
         ORDER BY b.spendable_base_units DESC, b.pubkey
         LIMIT $1`,
        [LEADERBOARD_LIMIT],
      );

      const body = {
        entries: rows.map((r) => ({
          rank: Number(r.rank),
          pubkey: r.pubkey,
          display_name: r.display_name,
          spendable_base_units: r.spendable_base_units,
          minted_base_units: r.minted_base_units,
          sent_base_units: r.sent_base_units,
          received_base_units: r.received_base_units,
        })),
        generated_at: new Date().toISOString(),
        limit: LEADERBOARD_LIMIT,
      };
      return buildCachedJsonResponse(body);
    });
  }

  app.get('/stats/leaderboard', async (req, reply) => {
    const cached = await leaderboardCachedResponse();
    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=10, stale-while-revalidate=60',
    );
  });
}
