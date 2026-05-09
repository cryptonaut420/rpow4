import { describe, it, expect } from 'vitest';
import { signSession, verifySession, createCachedSessionVerifier } from '../src/session.js';

describe('session token', () => {
  const secret = 's'.repeat(32);
  const pubkey = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

  it('signed token verifies and yields pubkey', () => {
    const tok = signSession({ pubkey }, secret, 60);
    const claim = verifySession(tok, secret);
    expect(claim?.pubkey).toBe(pubkey);
  });
  it('expired tokens fail', () => {
    const tok = signSession({ pubkey }, secret, -1);
    expect(verifySession(tok, secret)).toBeNull();
  });
  it('tampered tokens fail', () => {
    const tok = signSession({ pubkey }, secret, 60);
    expect(verifySession(tok + 'x', secret)).toBeNull();
  });
  it('rejects a session whose pubkey is not a valid base58 ed25519 pubkey', () => {
    const tok = signSession({ pubkey: 'definitely-not-a-real-pubkey' }, secret, 60);
    expect(verifySession(tok, secret)).toBeNull();
  });
});

describe('cached session verifier', () => {
  const secret = 's'.repeat(32);
  const pubkey = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

  it('returns the same SessionClaim on repeated calls without re-verifying', () => {
    const verify = createCachedSessionVerifier(secret);
    const tok = signSession({ pubkey }, secret, 60);
    const a = verify(tok);
    const b = verify(tok);
    expect(a?.pubkey).toBe(pubkey);
    expect(b).toBe(a);
  });

  it('caches negative results so a forged-token flood does not re-HMAC', () => {
    const verify = createCachedSessionVerifier(secret);
    const tok = 'not.a.valid.token';
    expect(verify(tok)).toBeNull();
    expect(verify(tok)).toBeNull();
  });

  it('re-evaluates a cached entry whose session-level exp has elapsed', () => {
    const verify = createCachedSessionVerifier(secret, { ttlMs: 10_000 });
    const tok = signSession({ pubkey }, secret, 1);
    const fresh = verify(tok);
    expect(fresh?.pubkey).toBe(pubkey);
    // Force-expire the underlying session without waiting a full second.
    (fresh as { exp: number }).exp = Math.floor(Date.now() / 1000) - 5;
    expect(verify(tok)).toBeNull();
  });
});
