import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveAsset } from '../assets.js';

interface MeRow {
  display_name: string | null;
  spendable: string;
  minted: string;
  sent: string;
  received: string;
  send_fees_waived: boolean;
  is_admin: boolean;
}

interface MeBalanceRow {
  asset_id: string;
  asset_slug: string;
  display_code: string;
  nickname: string;
  asset_kind: 'mineable' | 'external_custodial';
  system_default: boolean;
  sequence_number: number;
  spendable: string;
  minted: string;
  sent: string;
  received: string;
  events_count: string;
}

export async function meRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const asset = await resolveAsset(app, req);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: 'asset not found' });

    // Cache /me per-pubkey for 2s with single-flight on miss. Mint, send,
    // signup, and display-name change all call app.invalidateAccount() to
    // drop this entry immediately on writes that affect the user (or
    // their counterparty).
    const pubkey = s.pubkey;
    const body = await app.caches.me.get(`${asset.id}|${pubkey}`, async () => {
      const { rows } = await app.pool.query<MeRow>(
        `SELECT a.display_name,
                coalesce(a.send_fees_waived, false) AS send_fees_waived,
                coalesce(a.is_admin, false) AS is_admin,
                coalesce(b.spendable_base_units,0)::text AS spendable,
                coalesce(b.minted_base_units,0)::text AS minted,
                coalesce(b.sent_base_units,0)::text AS sent,
                coalesce(b.received_base_units,0)::text AS received
         FROM accounts a
         LEFT JOIN account_balances b ON b.asset_id=$1::uuid AND b.pubkey = a.pubkey
         WHERE a.pubkey=$2`,
        [asset.id, pubkey],
      );
      const account = rows[0];
      if (!account) return null;
      return {
        pubkey,
        asset_id: asset.id,
        asset_slug: asset.slug,
        asset_code: asset.displayCode,
        display_name: account.display_name,
        balance_base_units: account.spendable,
        minted_base_units: account.minted,
        sent_base_units: account.sent,
        received_base_units: account.received,
        send_fees_waived: account.send_fees_waived,
        is_admin: account.is_admin,
      };
    });
    if (body === null) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'account not found' });
    }
    // Per-user data: never cache at intermediaries. Browser revalidation
    // is fine, the server-side cache is what carries the load.
    reply.header('cache-control', 'private, max-age=0');
    return body;
  };

  app.get('/me', handler);
  app.get('/assets/:asset_slug/me', handler);

  // Multi-asset balances: returns one row per asset where the caller has a
  // balance row, plus the platform default (RPOW4.0) so it's always shown
  // even with a zero balance. Used by the wallet hub to render the
  // "ASSETS" overview without forcing N round-trips to /me.
  //
  // Response is intentionally compact (no schedule/pool config etc.) — the
  // /assets endpoint already covers the heavy asset metadata for any
  // consumer that needs more.
  app.get('/me/balances', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    // Includes any asset where the user has a balance row (zero or
    // positive), plus the platform default (RPOW4.0) and RPOW2 so the wallet
    // hub always makes the bridge easy to find. Other untouched assets are
    // intentionally omitted to keep the list focused.
    const { rows } = await app.pool.query<MeBalanceRow>(
      `SELECT a.id::text                                AS asset_id,
              a.slug                                    AS asset_slug,
              a.display_code,
              a.nickname,
              a.asset_kind,
              a.system_default,
              a.sequence_number,
              coalesce(b.spendable_base_units, 0)::text AS spendable,
              coalesce(b.minted_base_units,    0)::text AS minted,
              coalesce(b.sent_base_units,      0)::text AS sent,
              coalesce(b.received_base_units,  0)::text AS received,
              coalesce(b.events_count,         0)::text AS events_count
         FROM assets a
         LEFT JOIN account_balances b
                ON b.asset_id = a.id AND b.pubkey = $1
        WHERE a.status = 'active'
          AND (b.pubkey IS NOT NULL OR a.system_default = true OR a.slug = 'rpow2')
        ORDER BY a.system_default DESC, a.sequence_number ASC`,
      [s.pubkey],
    );

    reply.header('cache-control', 'private, max-age=0');
    return {
      pubkey: s.pubkey,
      balances: rows.map((r) => ({
        asset_id: r.asset_id,
        asset_slug: r.asset_slug,
        display_code: r.display_code,
        nickname: r.nickname,
        asset_kind: r.asset_kind,
        system_default: r.system_default,
        sequence_number: r.sequence_number,
        balance_base_units: r.spendable,
        minted_base_units: r.minted,
        sent_base_units: r.sent,
        received_base_units: r.received,
        events_count: Number(r.events_count),
      })),
    };
  });
}
