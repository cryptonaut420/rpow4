import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const pubkey = s.pubkey;
    const { rows } = await app.pool.query<{
      display_name: string | null;
      spendable: string;
      minted: string;
      sent: string;
      received: string;
    }>(
      `SELECT a.display_name,
              coalesce(b.spendable_base_units,0)::text AS spendable,
              coalesce(b.minted_base_units,0)::text AS minted,
              coalesce(b.sent_base_units,0)::text AS sent,
              coalesce(b.received_base_units,0)::text AS received
       FROM accounts a
       LEFT JOIN account_balances b ON b.pubkey = a.pubkey
       WHERE a.pubkey=$1`,
      [pubkey],
    );
    const account = rows[0];
    if (!account) return reply.code(404).send({ error: 'NOT_FOUND', message: 'account not found' });
    return {
      pubkey,
      display_name: account.display_name,
      balance_base_units: account.spendable,
      minted_base_units: account.minted,
      sent_base_units: account.sent,
      received_base_units: account.received,
    };
  });
}
