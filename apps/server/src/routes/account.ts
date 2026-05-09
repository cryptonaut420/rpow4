import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DISPLAY_NAME_MAX,
  validateDisplayName,
  verifyCanonical,
} from '@rpow/shared';

interface LookupHit {
  pubkey: string;
  display_name: string;
}

/**
 * Optional, per-account, case-insensitively unique display handle.
 *
 * It's NOT an authentication mechanism. Senders use it as a convenience to
 * resolve to a pubkey via /lookup/:name; from there the standard signed
 * /send flow takes over. The handle never appears in any signed token
 * payload — only the underlying pubkey does.
 */
export async function accountRoutes(app: FastifyInstance) {
  /**
   * Set or clear the caller's display name. Body is signed with the
   * caller's keypair under the `account.set_display_name` action.
   */
  app.post('/me/display_name', async (req, reply) => {
    const s = app.readSession(req);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const Body = z.object({
      display_name: z.union([z.string(), z.null()]),
      client_signature_base58: z.string().min(64).max(128),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const { display_name, client_signature_base58 } = parsed.data;

    let normalized: string | null;
    if (display_name === null || display_name.trim() === '') {
      normalized = null;
    } else {
      const v = validateDisplayName(display_name);
      if (!v.ok) return reply.code(400).send({ error: 'BAD_REQUEST', message: v.message });
      normalized = v.normalized;
    }

    // Sign over the canonical body (without the signature field). For the
    // "clear" case the signed value is explicitly null — keeps the wire
    // shape symmetric.
    const signedBody = { display_name: normalized };
    if (!verifyCanonical('account.set_display_name', signedBody, client_signature_base58, s.pubkey)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'signature does not verify' });
    }

    // The previous handle (if any) needs to be evicted from the lookup
    // cache too, otherwise a freed name keeps resolving to the old owner
    // for up to 30s.
    const { rows: prevRows } = await app.pool.query<{ display_name: string | null }>(
      `SELECT display_name FROM accounts WHERE pubkey=$1`,
      [s.pubkey],
    );
    const previousName = prevRows[0]?.display_name ?? null;

    try {
      // Explicit ::text casts on the nullable parameters: Postgres can't
      // infer their type from the CASE expressions otherwise (and would
      // bail with "could not determine data type of parameter $N").
      await app.pool.query(
        `UPDATE accounts
            SET display_name = $2::text,
                display_name_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                display_name_signature_base58 = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::text END
          WHERE pubkey = $1`,
        [s.pubkey, normalized, client_signature_base58],
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'NAME_TAKEN', message: 'that display name is already taken' });
      }
      throw e;
    }

    // Drop caches that depend on this account's display name. /activity
    // joins counterparty pubkeys to their current handle; arbitrary
    // other users could have this pubkey cached as a counterparty, so
    // clear the whole activity cache. Display name changes are rare
    // and the cache is in-process, so a flush is cheap.
    app.invalidateAccount(s.pubkey);
    app.invalidateLookup(previousName);
    app.invalidateLookup(normalized);
    app.caches.activity.clear();

    return { ok: true as const, display_name: normalized };
  });

  /**
   * Public lookup: resolve a display name to a pubkey. Case-insensitive.
   * Open to anyone (no session required) so unauthenticated UIs can show
   * "you're sending to alice" before the user has signed in.
   *
   * Cached for 30s per (lower-cased) name with single-flight on miss.
   * Cached entries — including misses (null) — are explicitly evicted
   * by /me/display_name above so a freed/taken name flips immediately.
   */
  app.get<{ Params: { name: string } }>(
    '/lookup/:name',
    async (req, reply) => {
      const raw = req.params.name ?? '';
      if (raw.length === 0 || raw.length > DISPLAY_NAME_MAX) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid display name' });
      }
      const cacheKey = raw.toLowerCase();
      const hit = await app.caches.lookup.get(cacheKey, async () => {
        const { rows } = await app.pool.query<LookupHit>(
          `SELECT pubkey, display_name FROM accounts WHERE lower(display_name) = lower($1) LIMIT 1`,
          [raw],
        );
        return rows[0] ?? null;
      });
      reply.header('cache-control', 'public, max-age=10');
      if (hit === null) {
        return reply.code(404).send({ error: 'NAME_NOT_FOUND', message: 'no account with that display name' });
      }
      return hit;
    },
  );
}
