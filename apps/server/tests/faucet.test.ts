import { describe, it, expect } from 'vitest';
import { TREASURY_PUBKEY } from '@rpow/shared';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';

const DEFAULT_ASSET_ID = '00000000-0000-4000-8000-000000000000';

async function seedTreasury(
  pool: Awaited<ReturnType<typeof makeTestApp>>['pool'],
  amountBaseUnits: bigint,
): Promise<void> {
  await pool.query(
    `INSERT INTO accounts(pubkey) VALUES($1) ON CONFLICT (pubkey) DO NOTHING`,
    [TREASURY_PUBKEY],
  );
  await pool.query(
    `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units)
     VALUES($1::uuid, $2, $3)
     ON CONFLICT (asset_id, pubkey) DO UPDATE SET spendable_base_units = EXCLUDED.spendable_base_units`,
    [DEFAULT_ASSET_ID, TREASURY_PUBKEY, amountBaseUnits.toString()],
  );
}

describe('faucet', () => {
  it('debits treasury and credits caller', async () => {
    const ctx = await makeTestApp();
    try {
      await seedTreasury(ctx.pool, 1_000_000_000_000n);
      const w = await loginAsRandomWallet(ctx.app);

      const r = await ctx.app.inject({
        method: 'POST',
        url: '/faucet/claim',
        headers: { cookie: w.cookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.ok).toBe(true);

      const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: w.cookie } });
      expect(BigInt(me.json().balance_base_units)).toBe(BigInt(body.amount_base_units));
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns 503 TREASURY_DRY when treasury is empty', async () => {
    const ctx = await makeTestApp();
    try {
      const w = await loginAsRandomWallet(ctx.app);
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/faucet/claim',
        headers: { cookie: w.cookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe('TREASURY_DRY');
    } finally {
      await ctx.cleanup();
    }
  });

  it('enforces cooldown after a successful claim', async () => {
    const ctx = await makeTestApp();
    try {
      await seedTreasury(ctx.pool, 1_000_000_000_000n);
      const w = await loginAsRandomWallet(ctx.app);

      const r1 = await ctx.app.inject({ method: 'POST', url: '/faucet/claim', headers: { cookie: w.cookie }, payload: {} });
      expect(r1.statusCode).toBe(200);

      const r2 = await ctx.app.inject({ method: 'POST', url: '/faucet/claim', headers: { cookie: w.cookie }, payload: {} });
      expect(r2.statusCode).toBe(429);
      expect(r2.json().error).toBe('COOLDOWN_ACTIVE');
    } finally {
      await ctx.cleanup();
    }
  });

  it('bumps user_count when first balance row is created', async () => {
    const ctx = await makeTestApp();
    try {
      await seedTreasury(ctx.pool, 1_000_000_000_000n);

      const before = await ctx.pool.query<{ value: string }>(
        `SELECT value::text AS value FROM ledger_stats WHERE asset_id=$1::uuid AND name='user_count'`,
        [DEFAULT_ASSET_ID],
      );
      const beforeCount = BigInt(before.rows[0]!.value);

      const w = await loginAsRandomWallet(ctx.app);
      const r = await ctx.app.inject({ method: 'POST', url: '/faucet/claim', headers: { cookie: w.cookie }, payload: {} });
      expect(r.statusCode).toBe(200);

      const after = await ctx.pool.query<{ value: string }>(
        `SELECT value::text AS value FROM ledger_stats WHERE asset_id=$1::uuid AND name='user_count'`,
        [DEFAULT_ASSET_ID],
      );
      expect(BigInt(after.rows[0]!.value)).toBe(beforeCount + 1n);
    } finally {
      await ctx.cleanup();
    }
  });
});
