import { describe, it, expect, afterEach } from 'vitest';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';
import { DEFAULT_ASSET_ID, LAUNCH_BURN_BASE_UNITS } from '../src/assets.js';

async function fundDefaultRpow(ctx: Awaited<ReturnType<typeof makeTestApp>>, pubkey: string, amount: bigint) {
  await ctx.pool.query(
    `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, updated_at)
     VALUES($1::uuid, $2, $3, now())
     ON CONFLICT (asset_id, pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       updated_at = now()`,
    [DEFAULT_ASSET_ID, pubkey, amount.toString()],
  );
  await ctx.pool.query(
    `UPDATE ledger_stats SET value = value + $2::bigint, updated_at = now()
     WHERE asset_id=$1::uuid AND name='circulating_supply'`,
    [DEFAULT_ASSET_ID, amount.toString()],
  );
}

describe('multi asset launch', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('lists the seeded RPOW4.0 asset', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/assets' });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets[0]).toMatchObject({
      slug: 'rpow4-0',
      display_code: 'RPOW4.0',
      system_default: true,
    });
  });

  it('requires authentication to launch an asset', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/assets',
      headers: { 'content-type': 'application/json' },
      payload: { nickname: 'No Session', supply_mode: 'capped' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('burns 10,000 RPOW4 and creates a custom asset atomically', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    await fundDefaultRpow(ctx, w.publicKeyBase58, LAUNCH_BURN_BASE_UNITS);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/assets',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: {
        nickname: 'Test Beans',
        description: 'mineable test asset',
        supply_mode: 'capped',
        max_supply_base_units: '21000000000000000',
        founder_allocation_base_units: '0',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.slug).toContain('test-beans');

    const burned = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE asset_id=$1::uuid AND name='burned_supply'`,
      [DEFAULT_ASSET_ID],
    );
    expect(burned.rows[0]?.value).toBe(LAUNCH_BURN_BASE_UNITS.toString());

    const burnEvent = await ctx.pool.query<{ event_type: string; amount: string }>(
      `SELECT event_type, amount::text AS amount
       FROM ledger_events
       WHERE asset_id=$1::uuid AND id=$2::uuid`,
      [DEFAULT_ASSET_ID, res.json().launch_burn_event_id],
    );
    expect(burnEvent.rows[0]).toMatchObject({
      event_type: 'BURN',
      amount: LAUNCH_BURN_BASE_UNITS.toString(),
    });
  });
});
