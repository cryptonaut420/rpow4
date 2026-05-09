import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  isValidPubkeyBase58,
  signupPowPrefixBytes,
  signupPowPrefixHex,
  validateDisplayName,
  verifyCanonical,
  type SignupChallengeEnvelope,
} from '@rpow/shared';
import { verifySolution } from '../pow.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../session.js';
import { withTxRetry } from '../db.js';

const SIGNUP_TTL_MS = 60 * 60 * 1000; // 1h, generous so a slow phone has time
const DOMAIN = 'rpow2.signup';

function macEnvelope(envelope: SignupChallengeEnvelope, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(envelope)).digest('hex');
}

function macsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const ChallengeBody = z.object({
  handle: z.string().min(1).max(64),
  pubkey: z.string().refine(isValidPubkeyBase58, { message: 'invalid base58 Ed25519 pubkey' }),
});

const EnvelopeShape = z.object({
  handle: z.string(),
  pubkey: z.string(),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  difficulty_bits: z.number().int().min(8).max(40),
  issued_at: z.string(),
  expires_at: z.string(),
  domain: z.string(),
});

const SignupBody = z.object({
  envelope: EnvelopeShape,
  envelope_mac: z.string().regex(/^[0-9a-f]{64}$/, 'envelope_mac must be 32 bytes hex'),
  solution_nonce: z.string().regex(/^\d+$/, 'solution_nonce must be a decimal u64'),
  client_signature_base58: z.string().min(64).max(128),
});

/**
 * Anti-spam, PoW-gated account registration.
 *
 *   client                                     server
 *   ──────                                     ──────
 *   POST /signup/challenge { handle, pubkey } ──►
 *                                              validate handle format,
 *                                              check availability,
 *                                              issue HMAC'd envelope
 *                                              { nonce, difficulty_bits, ... }
 *                                ◄────────────  envelope + mac + pow_prefix_hex
 *   mine for ~5–10s on a modern CPU, find
 *   solution_nonce s.t.
 *     trailing_zero_bits(
 *       sha256(prefix_bytes || u64le(solution_nonce))
 *     ) ≥ difficulty_bits
 *   sign canonicalMessage('account.signup',
 *                         { handle, pubkey, nonce })
 *   POST /signup { envelope, mac, solution_nonce, sig } ──►
 *                                              verify mac + expiry +
 *                                              PoW + signature, then
 *                                              INSERT into accounts
 *                                              with display_name set
 *                                              atomically. Drops session
 *                                              cookie on success.
 *                                ◄────────────  { ok, pubkey, display_name }
 *
 * No DB row is reserved at challenge-time; the envelope is purely
 * server-HMAC'd. A handle race between two simultaneous signups is
 * resolved by the unique index on `accounts.display_name` — the loser
 * gets 409 NAME_TAKEN.
 */
export async function signupRoutes(app: FastifyInstance) {
  app.post(
    '/signup/challenge',
    {
      // /signup/challenge does a single SELECT but is otherwise free —
      // an attacker could issue thousands of envelopes per second to
      // probe handle availability. Cap aggressively per IP.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const v = validateDisplayName(parsed.data.handle);
    if (!v.ok) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: v.message });
    }
    const handle = v.normalized;
    const pubkey = parsed.data.pubkey;

    const { rows } = await app.pool.query<{ pubkey: string }>(
      `SELECT pubkey FROM accounts WHERE lower(display_name) = lower($1) LIMIT 1`,
      [handle],
    );
    if (rows.length > 0) {
      return reply.code(409).send({ error: 'NAME_TAKEN', message: 'that name is already taken' });
    }

    const now = Date.now();
    const envelope: SignupChallengeEnvelope = {
      handle,
      pubkey,
      nonce: randomBytes(16).toString('hex'),
      difficulty_bits: app.config.signupDifficultyBits,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + SIGNUP_TTL_MS).toISOString(),
      domain: DOMAIN,
    };
    return {
      envelope,
      envelope_mac: macEnvelope(envelope, app.config.sessionSecret),
      pow_prefix_hex: signupPowPrefixHex({
        nonce_hex: envelope.nonce,
        handle: envelope.handle,
        pubkey: envelope.pubkey,
      }),
    };
  });

  app.post(
    '/signup',
    {
      // Signup is PoW-gated, but the post-PoW commit costs a real
      // transaction; cap how many an IP can fire even with valid
      // solutions.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const { envelope, envelope_mac, solution_nonce, client_signature_base58 } = parsed.data;

    if (envelope.domain !== DOMAIN) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'envelope domain mismatch' });
    }
    if (!isValidPubkeyBase58(envelope.pubkey)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid pubkey in envelope' });
    }
    const v = validateDisplayName(envelope.handle);
    if (!v.ok || v.normalized !== envelope.handle) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid handle in envelope' });
    }
    if (envelope.difficulty_bits !== app.config.signupDifficultyBits) {
      // Server tightened (or relaxed) difficulty since this envelope was
      // issued. Force a new challenge so we can't be downgrade-attacked.
      return reply.code(409).send({ error: 'SIGNUP_EXPIRED', message: 'difficulty changed; request a new challenge' });
    }

    const expectedMac = macEnvelope(envelope, app.config.sessionSecret);
    if (!macsEqual(expectedMac, envelope_mac)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'envelope mac mismatch' });
    }

    const expMs = Date.parse(envelope.expires_at);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      return reply.code(409).send({ error: 'SIGNUP_EXPIRED', message: 'signup challenge expired; request a new one' });
    }

    // Verify PoW.
    let nonceBigint: bigint;
    try {
      nonceBigint = BigInt(solution_nonce);
    } catch {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid solution_nonce' });
    }
    const prefix = Buffer.from(signupPowPrefixBytes({
      nonce_hex: envelope.nonce,
      handle: envelope.handle,
      pubkey: envelope.pubkey,
    }));
    if (!verifySolution(prefix, nonceBigint, envelope.difficulty_bits)) {
      return reply.code(400).send({ error: 'INVALID_SOLUTION', message: 'PoW solution does not meet difficulty' });
    }

    // Verify the client signed this signup. Prevents a bystander who
    // captures a valid (envelope, solution) pair from registering an
    // account they don't actually control. (Even without the sig the
    // attack is purely griefing — they couldn't authenticate later —
    // but it's cheap defense in depth.)
    const signedBody = {
      handle: envelope.handle,
      pubkey: envelope.pubkey,
      nonce: envelope.nonce,
    };
    if (!verifyCanonical('account.signup', signedBody, client_signature_base58, envelope.pubkey)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'signature does not verify' });
    }

    // Atomically create the account with the handle bound. Two unique
    // constraints can fire here: the primary key on pubkey (already
    // signed up before) and the partial unique index on
    // lower(display_name) (handle taken between challenge and submit).
    try {
      await withTxRetry(app.pool, async (c) => {
        await c.query(
          `INSERT INTO accounts(pubkey, display_name, display_name_set_at, display_name_signature_base58)
           VALUES ($1, $2, now(), $3)`,
          [envelope.pubkey, envelope.handle, client_signature_base58],
        );
        await c.query(
          `INSERT INTO account_balances(pubkey) VALUES($1)
           ON CONFLICT (pubkey) DO NOTHING`,
          [envelope.pubkey],
        );
        await c.query(
          `UPDATE ledger_stats SET value = value + 1, updated_at = now()
           WHERE name='user_count'`,
        );
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        // constraint_name distinguishes the two cases.
        if (typeof e?.constraint === 'string' && e.constraint.includes('display_name')) {
          return reply.code(409).send({ error: 'NAME_TAKEN', message: 'that name was just taken' });
        }
        return reply.code(409).send({ error: 'BAD_REQUEST', message: 'account already exists' });
      }
      throw e;
    }

    // New account is now visible to /me and /lookup; the lookup cache
    // also held a `null` (NAME_NOT_FOUND) entry from the availability
    // check. Drop both before issuing the session.
    app.invalidateAccount(envelope.pubkey);
    app.invalidateLookup(envelope.handle);
    app.invalidateLedger();

    const sessionToken = signSession({ pubkey: envelope.pubkey }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: app.config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return { ok: true as const, pubkey: envelope.pubkey, display_name: envelope.handle };
  });
}
