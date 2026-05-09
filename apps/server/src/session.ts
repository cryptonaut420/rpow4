import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidPubkeyBase58 } from '@rpow/shared';
import { TtlCache } from './cache.js';

/**
 * HMAC-signed session cookie. The cookie carries the user's base58 Ed25519
 * pubkey — the same pubkey their browser-side wallet signs with — so the
 * server can authorize requests without needing a server-side session
 * store. The HMAC tag prevents tampering; the wallet's authentication
 * happened earlier at /auth/session.
 */
export interface SessionClaim {
  pubkey: string;
  exp: number; // unix seconds
}

export function signSession(claim: { pubkey: string }, secret: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ pubkey: claim.pubkey, exp })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionClaim | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaim;
    if (typeof c.pubkey !== 'string' || typeof c.exp !== 'number') return null;
    if (!isValidPubkeyBase58(c.pubkey)) return null;
    if (Math.floor(Date.now() / 1000) >= c.exp) return null;
    return c;
  } catch { return null; }
}

export const SESSION_COOKIE = 'rpow_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Session tokens are immutable until they expire (30 days), so the same
 * cookie that arrives on every request from a logged-in browser produces
 * the same SessionClaim. Cache the verify() result keyed by the raw token
 * so authenticated hot paths skip HMAC + base64-decode + JSON.parse on
 * every call.
 *
 * Negative results are cached too — a flood of malformed/forged cookies
 * otherwise hits HMAC on each request. The LRU bound stops a unique-token
 * flood from growing the cache without limit.
 */
export interface CachedSessionVerifier {
  (token: string): SessionClaim | null;
  /** Test-only: drop all cached verify results. */
  clear(): void;
}

export interface CachedVerifyOptions {
  ttlMs?: number;
  maxSize?: number;
}

export function createCachedSessionVerifier(
  secret: string,
  opts: CachedVerifyOptions = {},
): CachedSessionVerifier {
  const cache = new TtlCache<string, SessionClaim | null>({
    ttlMs: opts.ttlMs ?? 30_000,
    maxSize: opts.maxSize ?? 50_000,
  });
  const verify = (token: string): SessionClaim | null => {
    const cached = cache.peek(token);
    if (cached !== undefined) {
      // Cache TTL is much shorter than session TTL, but a cached entry
      // can still cross its own exp boundary while pinned. Re-check.
      if (cached === null) return null;
      if (Math.floor(Date.now() / 1000) >= cached.exp) {
        cache.invalidate(token);
        return null;
      }
      return cached;
    }
    const result = verifySession(token, secret);
    cache.set(token, result);
    return result;
  };
  return Object.assign(verify, { clear: () => cache.clear() });
}
