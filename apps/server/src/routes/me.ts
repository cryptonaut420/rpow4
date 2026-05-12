import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveAsset } from '../assets.js';

interface MeRow {
  display_name: string | null;
  spendable: string;
  minted: string;
  sent: string;
  received: string;
  send_fees_waived: boolean;
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
}
