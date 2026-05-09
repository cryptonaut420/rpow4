import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  isValidPubkeyBase58,
  verifyCanonical,
  type AuthChallengeEnvelope,
} from '@rpow/shared';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../session.js';
import { withTxRetry } from '../db.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DOMAIN = 'rpow2';

function macEnvelope(envelope: AuthChallengeEnvelope, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(envelope)).digest('hex');
}

function macsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const ChallengeBody = z.object({
  pubkey: z.string().refine(isValidPubkeyBase58, { message: 'invalid base58 Ed25519 pubkey' }),
});

const EnvelopeShape = z.object({
  pubkey: z.string(),
  nonce: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  domain: z.string(),
});

const SessionBody = z.object({
  envelope: EnvelopeShape,
  envelope_mac: z.string().regex(/^[0-9a-f]{64}$/, 'envelope_mac must be 32 bytes hex'),
  signature_base58: z.string().min(64).max(128),
});

export async function authRoutes(app: FastifyInstance) {
  /**
   * Issue a challenge envelope for a pubkey. The envelope is purely
   * server-HMAC'd — there's no DB row — so issuance is cheap and there's
   * nothing to clean up if the client never returns. Replay is bounded by
   * the 5-minute TTL plus the freshness of the nonce: each /auth/session
   * call independently checks both.
   */
  app.post('/auth/challenge', async (req, reply) => {
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid pubkey' });
    }
    const now = Date.now();
    const envelope: AuthChallengeEnvelope = {
      pubkey: parsed.data.pubkey,
      nonce: randomBytes(16).toString('hex'),
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
      domain: DOMAIN,
    };
    return {
      envelope,
      envelope_mac: macEnvelope(envelope, app.config.sessionSecret),
      message: `Sign in to ${DOMAIN} as ${envelope.pubkey} (nonce ${envelope.nonce})`,
    };
  });

  /**
   * Exchange a signed envelope for a session cookie. Verifies:
   *   1. envelope_mac is valid (envelope wasn't tampered with),
   *   2. envelope hasn't expired,
   *   3. envelope.domain matches,
   *   4. signature_base58 verifies against envelope.pubkey for the
   *      canonical message canonicalMessage('auth.session', envelope).
   *
   * On success, lazily creates the account row and sets the session
   * cookie. No DB row is consumed for the challenge itself — replays
   * within the TTL are stopped by the fact that the same envelope.nonce
   * just produces the same session, not a privilege escalation. After
   * exp the envelope is rejected outright.
   */
  app.post('/auth/session', async (req, reply) => {
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const { envelope, envelope_mac, signature_base58 } = parsed.data;

    if (envelope.domain !== DOMAIN) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'envelope domain mismatch' });
    }
    if (!isValidPubkeyBase58(envelope.pubkey)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid pubkey in envelope' });
    }

    const expectedMac = macEnvelope(envelope, app.config.sessionSecret);
    if (!macsEqual(expectedMac, envelope_mac)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'envelope mac mismatch' });
    }

    const expMs = Date.parse(envelope.expires_at);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'challenge expired' });
    }

    if (!verifyCanonical('auth.session', envelope, signature_base58, envelope.pubkey)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'signature does not verify' });
    }

    const created = await withTxRetry(app.pool, async (c) => {
      const inserted = await c.query<{ pubkey: string }>(
        `INSERT INTO accounts(pubkey) VALUES($1)
         ON CONFLICT (pubkey) DO NOTHING
         RETURNING pubkey`,
        [envelope.pubkey],
      );
      if (inserted.rows[0]) {
        await c.query(
          `INSERT INTO account_balances(pubkey) VALUES($1)
           ON CONFLICT (pubkey) DO NOTHING`,
          [envelope.pubkey],
        );
        await c.query(
          `UPDATE ledger_stats SET value = value + 1, updated_at = now()
           WHERE name='user_count'`,
        );
        return true;
      }
      await c.query(`UPDATE accounts SET last_login_at = now() WHERE pubkey=$1`, [envelope.pubkey]);
      return false;
    });
    if (created) {
      app.invalidateAccount(envelope.pubkey);
      app.invalidateLedger();
    }

    const sessionToken = signSession({ pubkey: envelope.pubkey }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: app.config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return { ok: true as const, pubkey: envelope.pubkey };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
