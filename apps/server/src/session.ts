import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidPubkeyBase58 } from '@rpow/shared';

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
