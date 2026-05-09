import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, w: TestWallet, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json() as {
      challenge_id: string;
      nonce_prefix: string;
      difficulty_bits: number;
      issued_at: string;
      expires_at: string;
      challenge_mac: string;
    };
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const body = { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() };
    await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: {
        challenge_id: ch.challenge_id,
        nonce_prefix: ch.nonce_prefix,
        difficulty_bits: ch.difficulty_bits,
        issued_at: ch.issued_at,
        expires_at: ch.expires_at,
        challenge_mac: ch.challenge_mac,
        solution_nonce: nonce.toString(),
        client_signature_base58: w.sign('mint', body),
      },
    });
  }
}

describe('GET /activity', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('shows mint, send, receive entries with counterparty_pubkey + client_signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await mineN(ctx, a, 2);
    // Each mint credits 7,812,500 base units; send one full token's worth so
    // the exact-sum lock can pick a single token.
    const sendBody = {
      recipient_pubkey: b.publicKeyBase58,
      amount_base_units: '7812500',
      idempotency_key: randomUUID(),
    };
    const r = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: { ...sendBody, client_signature_base58: a.sign('transfer', sendBody) },
    });
    expect(r.statusCode).toBe(200);

    const aAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a.cookie } })).json() as Array<any>;
    const bAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: b.cookie } })).json() as Array<any>;

    expect(aAct.find((e) => e.type === 'mint')).toBeTruthy();
    const sent = aAct.find((e) => e.type === 'send' && e.counterparty_pubkey === b.publicKeyBase58);
    expect(sent).toBeTruthy();
    expect(sent.client_signature_base58).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);

    const received = bAct.find((e) => e.type === 'receive' && e.counterparty_pubkey === a.publicKeyBase58);
    expect(received).toBeTruthy();
    expect(received.client_signature_base58).toBe(sent.client_signature_base58);
  });
});
