import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    // amount is BIGINT base units; cast to text so node-postgres returns it
    // as a string. Transfer signatures stay attached to events so consumers
    // can cryptographically verify sender authorization.
    //
    // counterparty_display_name is the *current* handle for the
    // counterparty pubkey (LEFT JOIN to accounts), purely for nicer
    // rendering — the canonical/signed identity stays the pubkey.
    const sql = `
      WITH events AS (
        (SELECT 'mint' AS type,
                amount::text AS amount,
                NULL::text AS counterparty_pubkey,
                NULL::text AS client_signature_base58,
                created_at AS at,
                event_seq
         FROM ledger_events
         WHERE event_type='MINT' AND actor_pubkey=$1
         ORDER BY event_seq DESC
         LIMIT 100)
        UNION ALL
        (SELECT 'send' AS type,
                amount::text AS amount,
                counterparty_pubkey,
                client_signature_base58,
                created_at AS at,
                event_seq
         FROM ledger_events
         WHERE event_type='TRANSFER' AND actor_pubkey=$1
         ORDER BY event_seq DESC
         LIMIT 100)
        UNION ALL
        (SELECT 'receive' AS type,
                amount::text AS amount,
                actor_pubkey AS counterparty_pubkey,
                client_signature_base58,
                created_at AS at,
                event_seq
         FROM ledger_events
         WHERE event_type='TRANSFER' AND counterparty_pubkey=$1
         ORDER BY event_seq DESC
         LIMIT 100)
      )
      SELECT events.type, events.amount, events.counterparty_pubkey,
             events.client_signature_base58, events.at,
             a.display_name AS counterparty_display_name
      FROM events
      LEFT JOIN accounts a ON a.pubkey = events.counterparty_pubkey
      ORDER BY events.event_seq DESC
      LIMIT 100`;
    const { rows } = await app.pool.query(sql, [s.pubkey]);
    return rows.map((r) => ({
      type: r.type,
      amount_base_units: r.amount,
      counterparty_pubkey: r.counterparty_pubkey ?? undefined,
      counterparty_display_name: r.counterparty_display_name ?? undefined,
      client_signature_base58: r.client_signature_base58 ?? undefined,
      at: r.at.toISOString(),
    }));
  });
}
