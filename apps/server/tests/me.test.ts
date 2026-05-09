import { describe, it, expect, afterEach } from 'vitest';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';

describe('GET /me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns pubkey + zero balances on first login', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: w.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pubkey: w.publicKeyBase58,
      display_name: null,
      balance_base_units: '0',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
    });
  });
});
