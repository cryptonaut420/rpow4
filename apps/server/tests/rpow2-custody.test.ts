import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';
import { DEFAULT_ASSET_ID } from '../src/assets.js';
import { TREASURY_PUBKEY } from '@rpow/shared';

const RPOW2_ASSET_ID = '00000000-0000-4000-8000-000000000002';
const ONE = 1_000_000_000n;

async function setAdmin(ctx: Awaited<ReturnType<typeof makeTestApp>>, pubkey: string) {
  await ctx.pool.query(`UPDATE accounts SET is_admin=true WHERE pubkey=$1`, [pubkey]);
}

async function fundAsset(ctx: Awaited<ReturnType<typeof makeTestApp>>, assetId: string, pubkey: string, amount: bigint) {
  await ctx.pool.query(
    `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, updated_at)
     VALUES($1::uuid, $2, $3::bigint, $3::bigint, now())
     ON CONFLICT (asset_id, pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
       updated_at = now()`,
    [assetId, pubkey, amount.toString()],
  );
  await ctx.pool.query(
    `UPDATE ledger_stats SET value = value + $2::bigint WHERE asset_id=$1::uuid AND name='circulating_supply'`,
    [assetId, amount.toString()],
  );
  await ctx.pool.query(
    `UPDATE app_counters SET value = value + $2::bigint WHERE asset_id=$1::uuid AND name='minted_supply'`,
    [assetId, amount.toString()],
  );
}

async function fundRpow2(ctx: Awaited<ReturnType<typeof makeTestApp>>, pubkey: string, amount: bigint) {
  await fundAsset(ctx, RPOW2_ASSET_ID, pubkey, amount);
}

function orderBody(wallet: Awaited<ReturnType<typeof loginAsRandomWallet>>, body: Record<string, string>) {
  return {
    ...body,
    client_signature_base58: wallet.sign('market.order.create', body),
  };
}

describe('rpow2 custody', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { vi.restoreAllMocks(); if (cleanup) await cleanup(); cleanup = null; });

  it('seeds RPOW2 as an external asset with a 25 bps market', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const assets = await ctx.app.inject({ method: 'GET', url: '/assets' });
    expect(assets.statusCode).toBe(200);
    const rpow2 = assets.json().assets.find((a: any) => a.slug === 'rpow2');
    expect(rpow2.asset_kind).toBe('external_custodial');
    expect(rpow2.pool_enabled).toBe(false);

    const markets = await ctx.app.inject({ method: 'GET', url: '/markets' });
    expect(markets.statusCode).toBe(200);
    const market = markets.json().markets.find((m: any) => m.base_asset.slug === 'rpow2');
    expect(market.symbol).toBe('RPOW2/RPOW4.0');
    expect(market.taker_fee_bps).toBe(25);
  });

  it('locks RPOW2 on withdrawal request and refunds it on admin reject', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const user = await loginAsRandomWallet(ctx.app);
    const admin = await loginAsRandomWallet(ctx.app);
    await setAdmin(ctx, admin.publicKeyBase58);
    await fundRpow2(ctx, user.publicKeyBase58, 5n * ONE);

    const req = await ctx.app.inject({
      method: 'POST',
      url: '/custody/rpow2/withdrawals',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: { destination_email: 'user@example.com', amount_base_units: (2n * ONE).toString() },
    });
    expect(req.statusCode, req.body).toBe(200);
    const id = req.json().id;
    let bal = (await ctx.pool.query<{ spendable: string; locked: string }>(
      `SELECT spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [RPOW2_ASSET_ID, user.publicKeyBase58],
    )).rows[0]!;
    expect(bal.spendable).toBe((3n * ONE).toString());
    expect(bal.locked).toBe((2n * ONE).toString());

    const reject = await ctx.app.inject({
      method: 'POST',
      url: `/admin/custody/rpow2/withdrawals/${id}/reject`,
      headers: { cookie: admin.cookie },
    });
    expect(reject.statusCode).toBe(200);
    bal = (await ctx.pool.query<{ spendable: string; locked: string }>(
      `SELECT spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [RPOW2_ASSET_ID, user.publicKeyBase58],
    )).rows[0]!;
    expect(bal.spendable).toBe((5n * ONE).toString());
    expect(bal.locked).toBe('0');
  });

  it('honors disabled withdrawal and paused sync admin controls', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const user = await loginAsRandomWallet(ctx.app);
    const admin = await loginAsRandomWallet(ctx.app);
    await setAdmin(ctx, admin.publicKeyBase58);
    await fundRpow2(ctx, user.publicKeyBase58, 1n * ONE);

    await ctx.pool.query(
      `UPDATE external_asset_configs SET withdrawal_enabled=false WHERE provider_key='rpow2'`,
    );
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/custody/rpow2/withdrawals',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: { destination_email: 'user@example.com', amount_base_units: ONE.toString() },
    });
    expect(blocked.statusCode).toBe(503);

    await ctx.pool.query(
      `UPDATE external_sync_state SET paused=true, last_error='expired cookie' WHERE provider_key='rpow2'`,
    );
    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/admin/custody/rpow2/sync',
      headers: { cookie: admin.cookie },
    });
    expect(sync.statusCode).toBe(409);

    const resume = await ctx.app.inject({
      method: 'POST',
      url: '/admin/custody/rpow2/resume',
      headers: { cookie: admin.cookie },
    });
    expect(resume.statusCode).toBe(200);
    const state = (await ctx.pool.query<{ paused: boolean; last_error: string | null }>(
      `SELECT paused, last_error FROM external_sync_state WHERE provider_key='rpow2'`,
    )).rows[0]!;
    expect(state.paused).toBe(false);
    expect(state.last_error).toBeNull();

    await ctx.pool.query(`UPDATE external_asset_configs SET withdrawal_enabled=true WHERE provider_key='rpow2'`);
    const sending = await ctx.pool.query<{ id: string }>(
      `INSERT INTO external_withdrawals(
         id, asset_id, provider_key, requester_pubkey, destination_external_id,
         amount_base_units, status, idempotency_key
       )
       VALUES(gen_random_uuid(), $1::uuid, 'rpow2', $2, 'user@example.com', $3::bigint, 'sending', gen_random_uuid()::text)
       RETURNING id::text`,
      [RPOW2_ASSET_ID, user.publicKeyBase58, ONE.toString()],
    );
    const duplicateApprove = await ctx.app.inject({
      method: 'POST',
      url: `/admin/custody/rpow2/withdrawals/${sending.rows[0]!.id}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(duplicateApprove.statusCode).toBe(409);
  });

  it('trades RPOW2 against RPOW4.0 with the 0.25% fee credited as RPOW2 treasury', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const seller = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    await fundAsset(ctx, RPOW2_ASSET_ID, seller.publicKeyBase58, 5n * ONE);
    await fundAsset(ctx, DEFAULT_ASSET_ID, buyer.publicKeyBase58, 20n * ONE);

    const markets = await ctx.app.inject({ method: 'GET', url: '/markets' });
    const market = markets.json().markets.find((m: any) => m.base_asset.slug === 'rpow2');
    expect(market.taker_fee_bps).toBe(25);

    const sellBody = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: (4n * ONE).toString(),
      base_amount_base_units: ONE.toString(),
      client_order_id: randomUUID(),
    };
    const sell = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sellBody),
    });
    expect(sell.statusCode, sell.body).toBe(200);

    const buyBody = {
      market_id: market.id,
      side: 'buy',
      order_type: 'market',
      base_amount_base_units: ONE.toString(),
      max_quote_base_units: (5n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buy = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buyBody),
    });
    expect(buy.statusCode, buy.body).toBe(200);
    expect(buy.json().filled_base_units).toBe(ONE.toString());
    expect(buy.json().fee_base_units).toBe('2500000');
    expect(buy.json().trades[0].fee_asset_id).toBe(RPOW2_ASSET_ID);

    const treasury = (await ctx.pool.query<{ balance: string }>(
      `SELECT spendable_base_units::text AS balance
       FROM account_balances
       WHERE asset_id=$1::uuid AND pubkey=$2`,
      [RPOW2_ASSET_ID, TREASURY_PUBKEY],
    )).rows[0]!;
    expect(treasury.balance).toBe('2500000');
  });

  it('re-resolves an unattributed deposit on a later sync when the handle exists', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const user = await loginAsRandomWallet(ctx.app);
    const admin = await loginAsRandomWallet(ctx.app);
    await setAdmin(ctx, admin.publicKeyBase58);
    const entry = {
      type: 'receive',
      counterparty_email: 'sender@example.com',
      amount_base_units: (2n * ONE).toString(),
      memo: 'futurehandle',
      at: '2026-05-12T20:00:00.000Z',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ items: [entry] }),
    } as Response);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/admin/custody/rpow2/sync',
      headers: { cookie: admin.cookie },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().unattributed).toBe(1);

    await ctx.pool.query(
      `UPDATE accounts SET display_name='futurehandle' WHERE pubkey=$1`,
      [user.publicKeyBase58],
    );
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/admin/custody/rpow2/sync',
      headers: { cookie: admin.cookie },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().credited).toBe(1);
    const bal = (await ctx.pool.query<{ spendable: string }>(
      `SELECT spendable_base_units::text AS spendable
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [RPOW2_ASSET_ID, user.publicKeyBase58],
    )).rows[0]!;
    expect(bal.spendable).toBe((2n * ONE).toString());
  });

  it('exposes admin aggregates and splits sending withdrawals from action-needed pending', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const user = await loginAsRandomWallet(ctx.app);
    const admin = await loginAsRandomWallet(ctx.app);
    await setAdmin(ctx, admin.publicKeyBase58);
    await fundRpow2(ctx, user.publicKeyBase58, 5n * ONE);

    const reqA = await ctx.app.inject({
      method: 'POST',
      url: '/custody/rpow2/withdrawals',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: { destination_email: 'a@example.com', amount_base_units: ONE.toString() },
    });
    expect(reqA.statusCode).toBe(200);
    await ctx.pool.query(
      `INSERT INTO external_withdrawals(
         id, asset_id, provider_key, requester_pubkey, destination_external_id,
         amount_base_units, status, idempotency_key
       )
       VALUES(gen_random_uuid(), $1::uuid, 'rpow2', $2, 'sending@example.com', $3::bigint, 'sending', gen_random_uuid()::text)`,
      [RPOW2_ASSET_ID, user.publicKeyBase58, ONE.toString()],
    );

    const adminRes = await ctx.app.inject({
      method: 'GET',
      url: '/admin/custody/rpow2',
      headers: { cookie: admin.cookie },
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body.aggregates).toBeTruthy();
    expect(body.aggregates.withdrawals_pending).toBe(1);
    expect(body.aggregates.withdrawals_sending).toBe(1);
    expect(body.aggregates.treasury_spendable_base_units).toBe('0');
    expect(body.pending_withdrawals.length).toBe(1);
    expect(body.pending_withdrawals[0].status).toBe('pending_approval');
    expect(body.sending_withdrawals.length).toBe(1);
    expect(body.sending_withdrawals[0].status).toBe('sending');
  });

  it('lets admins assign an unattributed deposit to a pubkey exactly once', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const user = await loginAsRandomWallet(ctx.app);
    const admin = await loginAsRandomWallet(ctx.app);
    await setAdmin(ctx, admin.publicKeyBase58);
    const depositId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO external_deposits(
         id, asset_id, provider_key, fingerprint, sender_external_id, raw_memo,
         amount_base_units, external_observed_at, status
       )
       VALUES($1, $2::uuid, 'rpow2', $3, 'sender@example.com', 'bad memo', $4::bigint, now(), 'unattributed')`,
      [depositId, RPOW2_ASSET_ID, randomUUID(), (3n * ONE).toString()],
    );

    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/admin/custody/rpow2/deposits/${depositId}/assign`,
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      payload: { pubkey: user.publicKeyBase58 },
    });
    expect(assign.statusCode).toBe(200);
    const bal = (await ctx.pool.query<{ spendable: string }>(
      `SELECT spendable_base_units::text AS spendable
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [RPOW2_ASSET_ID, user.publicKeyBase58],
    )).rows[0]!;
    expect(bal.spendable).toBe((3n * ONE).toString());

    const activity = await ctx.app.inject({
      method: 'GET',
      url: '/assets/rpow2/activity',
      headers: { cookie: user.cookie },
    });
    expect(activity.statusCode).toBe(200);
    const depositEvent = activity.json().items.find((e: any) => e.type === 'mint');
    expect(depositEvent).toBeTruthy();
    expect(depositEvent.amount_base_units).toBe((3n * ONE).toString());
    expect(depositEvent.memo).toContain('RPOW2 deposit from sender@example.com');

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/admin/custody/rpow2/deposits/${depositId}/assign`,
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      payload: { pubkey: user.publicKeyBase58 },
    });
    expect(again.statusCode).toBe(404);
  });
});
