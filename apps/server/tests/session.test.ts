import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from '../src/session.js';

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
