import type { FastifyInstance } from 'fastify';

interface ActivityRow {
  type: 'mint' | 'send' | 'receive';
  event_seq: string;
  amount: string;
  counterparty_pubkey: string | null;
  client_signature_base58: string | null;
  at: Date;
  counterparty_display_name: string | null;
}

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    // amount is BIGINT base units; cast to text so node-postgres returns it
    // as a string. Transfer signatures stay attached to events so consumers
    // can cryptographically verify sender authorization.
    //
    // counterparty_display_name is the *current* handle for the
    // counterparty pubkey (LEFT JOIN to accounts), purely for nicer
    // rendering — the canonical/signed identity stays the pubkey.
    //
    // Per-pubkey cached for 2s with single-flight; writes affecting this
    // user (mint/send) drop the entry via app.invalidateAccount().
    const body = await app.caches.activity.get(s.pubkey, async () => {
      const recent = await app.pool.query<ActivityRow>(
        `SELECT e.type,
                e.event_seq::text AS event_seq,
                e.amount::text AS amount,
                e.counterparty_pubkey,
                e.client_signature_base58,
                e.created_at AS at,
                a.display_name AS counterparty_display_name
         FROM account_recent_events e
         LEFT JOIN accounts a ON a.pubkey = e.counterparty_pubkey
         WHERE e.pubkey=$1
         ORDER BY e.event_seq DESC
         LIMIT 101`,
        [s.pubkey],
      );

      let rows = recent.rows;
      // In steady state, account_recent_events is maintained in the same
      // transaction as every mint/send and usually has enough rows to
      // satisfy the activity page. If it has fewer than 100 rows, continue
      // from the oldest hot row into partitioned history so the route keeps
      // its "latest 100 events" contract after live migrations or for
      // low-activity accounts.
      if (rows.length < 100) {
        const oldestRecent = rows[rows.length - 1]?.event_seq ?? null;
        const historicalParams: unknown[] = [s.pubkey];
        let historicalCursorFilter = '';
        if (oldestRecent) {
          historicalParams.push(oldestRecent);
          historicalCursorFilter = `AND event_seq < $2::bigint`;
        }
        historicalParams.push(100 - rows.length);
        const historicalLimitParam = historicalParams.length;

        const sql = `
        WITH events AS (
          (SELECT 'mint' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  NULL::text AS counterparty_pubkey,
                  NULL::text AS client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='MINT' AND actor_pubkey=$1 ${historicalCursorFilter}
           ORDER BY event_seq DESC
           LIMIT $${historicalLimitParam})
          UNION ALL
          (SELECT 'send' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  counterparty_pubkey,
                  client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='TRANSFER' AND actor_pubkey=$1 ${historicalCursorFilter}
           ORDER BY event_seq DESC
           LIMIT $${historicalLimitParam})
          UNION ALL
          (SELECT 'receive' AS type,
                  event_seq::text AS event_seq,
                  amount::text AS amount,
                  actor_pubkey AS counterparty_pubkey,
                  client_signature_base58,
                  created_at AS at,
                  event_seq AS event_seq_sort
           FROM ledger_events
           WHERE event_type='TRANSFER' AND counterparty_pubkey=$1 ${historicalCursorFilter}
           ORDER BY event_seq DESC
           LIMIT $${historicalLimitParam})
        )
        SELECT events.type, events.amount, events.counterparty_pubkey,
               events.event_seq,
               events.client_signature_base58, events.at,
               a.display_name AS counterparty_display_name
        FROM events
        LEFT JOIN accounts a ON a.pubkey = events.counterparty_pubkey
        ORDER BY events.event_seq_sort DESC
        LIMIT $${historicalLimitParam}`;
        const historical = await app.pool.query<ActivityRow>(sql, historicalParams);
        rows = [...rows, ...historical.rows].slice(0, 100);
      } else {
        rows = rows.slice(0, 100);
      }

      return rows.map((r) => ({
        type: r.type,
        amount_base_units: r.amount,
        counterparty_pubkey: r.counterparty_pubkey ?? undefined,
        counterparty_display_name: r.counterparty_display_name ?? undefined,
        client_signature_base58: r.client_signature_base58 ?? undefined,
        at: r.at.toISOString(),
      }));
    });
    reply.header('cache-control', 'private, max-age=0');
    return body;
  });
}
