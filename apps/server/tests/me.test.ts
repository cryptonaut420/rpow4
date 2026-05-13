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
      asset_id: '00000000-0000-4000-8000-000000000000',
      asset_slug: 'rpow4-0',
      asset_code: 'RPOW4.0',
      display_name: null,
      balance_base_units: '0',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      send_fees_waived: false,
      is_admin: false,
    });
  });
});

describe('GET /me/balances', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me/balances' });
    expect(res.statusCode).toBe(401);
  });

  it('always pins RPOW4.0 and RPOW2 even with zero activity', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/me/balances',
      headers: { cookie: w.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pubkey).toBe(w.publicKeyBase58);
    expect(Array.isArray(body.balances)).toBe(true);
    const def = body.balances.find((b: any) => b.asset_slug === 'rpow4-0');
    expect(def).toBeTruthy();
    expect(def.system_default).toBe(true);
    expect(def.asset_kind).toBe('mineable');
    expect(def.balance_base_units).toBe('0');
    const rpow2 = body.balances.find((b: any) => b.asset_slug === 'rpow2');
    expect(rpow2).toBeTruthy();
    expect(rpow2.asset_kind).toBe('external_custodial');
    expect(rpow2.balance_base_units).toBe('0');
  });

  it('reflects positive balances for pinned RPOW2 and other visible assets', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);

    // Pre-state: RPOW2 is pinned so users can always find deposits/withdrawals.
    {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/me/balances',
        headers: { cookie: w.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const rpow2 = body.balances.find((b: any) => b.asset_slug === 'rpow2');
      expect(rpow2).toBeTruthy();
      expect(rpow2.balance_base_units).toBe('0');
    }

    // Manually credit RPOW4.0 + RPOW2 balances so the overview should now
    // surface both rows. We poke the balances table directly because the
    // mining/custody flows are exercised in their own dedicated tests.
    const rpow4 = await ctx.app.pool.query<{ id: string }>(`SELECT id FROM assets WHERE slug='rpow4-0'`);
    const rpow2 = await ctx.app.pool.query<{ id: string }>(`SELECT id FROM assets WHERE slug='rpow2'`);
    expect(rpow4.rows[0]).toBeTruthy();
    expect(rpow2.rows[0]).toBeTruthy();

    await ctx.app.pool.query(
      `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
       VALUES($1::uuid, $2, $3::bigint, $3::bigint, 1, now())
       ON CONFLICT (asset_id, pubkey) DO UPDATE SET
         spendable_base_units = EXCLUDED.spendable_base_units,
         received_base_units = EXCLUDED.received_base_units`,
      [rpow4.rows[0]!.id, w.publicKeyBase58, '12500000000'],
    );
    await ctx.app.pool.query(
      `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, received_base_units, events_count, updated_at)
       VALUES($1::uuid, $2, $3::bigint, $3::bigint, 1, now())
       ON CONFLICT (asset_id, pubkey) DO UPDATE SET
         spendable_base_units = EXCLUDED.spendable_base_units,
         received_base_units = EXCLUDED.received_base_units`,
      [rpow2.rows[0]!.id, w.publicKeyBase58, '50500000000'],
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/me/balances',
      headers: { cookie: w.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const def = body.balances.find((b: any) => b.asset_slug === 'rpow4-0');
    expect(def?.balance_base_units).toBe('12500000000');
    const r2 = body.balances.find((b: any) => b.asset_slug === 'rpow2');
    expect(r2).toBeTruthy();
    expect(r2!.asset_kind).toBe('external_custodial');
    expect(r2!.balance_base_units).toBe('50500000000');
    // RPOW4.0 is always sorted first (system_default DESC).
    expect(body.balances[0].asset_slug).toBe('rpow4-0');
  });
});
