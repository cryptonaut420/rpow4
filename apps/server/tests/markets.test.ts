import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ASSET_ID, LAUNCH_BURN_BASE_UNITS } from '../src/assets.js';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';

const ONE = 1_000_000_000n;

async function fundAsset(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  assetId: string,
  pubkey: string,
  amount: bigint,
) {
  // RETURNING (xmax = 0) tells us whether this insert created a new
  // (asset_id, pubkey) row. If it did, mirror the user_count bump that
  // production paths perform so the ledger_accounting_reconciliation
  // invariant `user_count = balance_row_count` holds in tests too.
  const credit = await ctx.pool.query<{ was_inserted: boolean }>(
    `INSERT INTO account_balances(asset_id, pubkey, spendable_base_units, minted_base_units, updated_at)
     VALUES($1::uuid, $2, $3, $3, now())
     ON CONFLICT (asset_id, pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       minted_base_units = account_balances.minted_base_units + EXCLUDED.minted_base_units,
       updated_at = now()
     RETURNING (xmax = 0) AS was_inserted`,
    [assetId, pubkey, amount.toString()],
  );
  if (credit.rows[0]?.was_inserted) {
    await ctx.pool.query(
      `UPDATE ledger_stats SET value = value + 1, updated_at = now()
       WHERE asset_id=$1::uuid AND name='user_count'`,
      [assetId],
    );
  }
  await ctx.pool.query(
    `UPDATE ledger_stats SET value = value + $2::bigint, updated_at = now()
     WHERE asset_id=$1::uuid AND name='circulating_supply'`,
    [assetId, amount.toString()],
  );
  await ctx.pool.query(
    `UPDATE app_counters SET value = value + $2::bigint
     WHERE asset_id=$1::uuid AND name='minted_supply'`,
    [assetId, amount.toString()],
  );
}

async function launchMarket(ctx: Awaited<ReturnType<typeof makeTestApp>>, owner: TestWallet) {
  await fundAsset(ctx, DEFAULT_ASSET_ID, owner.publicKeyBase58, LAUNCH_BURN_BASE_UNITS);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/assets',
    headers: { cookie: owner.cookie, 'content-type': 'application/json' },
    payload: {
      nickname: 'Market Coin',
      description: 'test market asset',
      supply_mode: 'capped',
      max_supply_base_units: '21000000000000000',
      founder_allocation_base_units: '0',
    },
  });
  expect(res.statusCode).toBe(201);
  const asset = res.json().asset;
  const markets = await ctx.app.inject({ method: 'GET', url: '/markets' });
  expect(markets.statusCode).toBe(200);
  const market = markets.json().markets.find((m: any) => m.base_asset.id === asset.id);
  expect(market).toBeTruthy();
  return { asset, market };
}

function orderBody(wallet: TestWallet, body: Record<string, string>) {
  return {
    ...body,
    client_signature_base58: wallet.sign('market.order.create', body),
  };
}

describe('internal markets', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('seeds a market when a custom asset is launched', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, w);
    expect(market.symbol).toBe(`${asset.display_code}/RPOW4.0`);
    expect(market.taker_fee_bps).toBe(0);
  });

  it('reserves a sell limit order, fills it with a market buy, and keeps the remainder locked', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);
    await fundAsset(ctx, asset.id, seller.publicKeyBase58, 10n * ONE);
    await fundAsset(ctx, DEFAULT_ASSET_ID, buyer.publicKeyBase58, 50n * ONE);

    const sell = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: (2n * ONE).toString(),
      base_amount_base_units: (10n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const sellRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sell),
    });
    expect(sellRes.statusCode).toBe(200);
    expect(sellRes.json().order.status).toBe('open');

    const sellerLocked = await ctx.pool.query<{ spendable: string; locked: string }>(
      `SELECT spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [asset.id, seller.publicKeyBase58],
    );
    expect(sellerLocked.rows[0]).toMatchObject({ spendable: '0', locked: (10n * ONE).toString() });

    const buy = {
      market_id: market.id,
      side: 'buy',
      order_type: 'market',
      base_amount_base_units: (4n * ONE).toString(),
      max_quote_base_units: (8n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buyRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buy),
    });
    expect(buyRes.statusCode).toBe(200);
    expect(buyRes.json()).toMatchObject({
      filled_base_units: (4n * ONE).toString(),
      spent_quote_base_units: (8n * ONE).toString(),
    });
    const buyRetry = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buy),
    });
    expect(buyRetry.statusCode).toBe(200);
    expect(buyRetry.json()).toMatchObject({
      filled_base_units: (4n * ONE).toString(),
      spent_quote_base_units: (8n * ONE).toString(),
      fee_base_units: '0',
    });
    expect(buyRetry.json().trades).toHaveLength(1);

    const buyerBase = await ctx.pool.query<{ spendable: string }>(
      `SELECT spendable_base_units::text AS spendable
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [asset.id, buyer.publicKeyBase58],
    );
    expect(buyerBase.rows[0].spendable).toBe((4n * ONE).toString());

    const sellerAfter = await ctx.pool.query<{ quote: string; locked: string }>(
      `SELECT
         (SELECT spendable_base_units::text FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$3) AS quote,
         (SELECT locked_base_units::text FROM account_balances WHERE asset_id=$2::uuid AND pubkey=$3) AS locked`,
      [DEFAULT_ASSET_ID, asset.id, seller.publicKeyBase58],
    );
    expect(sellerAfter.rows[0]).toMatchObject({
      quote: (8n * ONE).toString(),
      locked: (6n * ONE).toString(),
    });
  });

  it('charges taker fees in quote against treasury for both sides without minting tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);

    // Bump the taker fee to 100 bps so we can observe the routing in
    // both directions without depending on default config.
    await ctx.pool.query(`UPDATE markets SET taker_fee_bps=100 WHERE id=$1::uuid`, [market.id]);

    await fundAsset(ctx, asset.id, seller.publicKeyBase58, 5n * ONE);
    await fundAsset(ctx, DEFAULT_ASSET_ID, buyer.publicKeyBase58, 100n * ONE);

    // Seller posts a resting limit-sell, buyer takes it (buy-taker case).
    const sell = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: (10n * ONE).toString(),
      base_amount_base_units: (2n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const sellRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sell),
    });
    expect(sellRes.statusCode).toBe(200);

    const buy = {
      market_id: market.id,
      side: 'buy',
      order_type: 'market',
      base_amount_base_units: (2n * ONE).toString(),
      max_quote_base_units: (25n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buyRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buy),
    });
    expect(buyRes.statusCode).toBe(200);
    const buyJson = buyRes.json();
    expect(buyJson.fee_base_units).toBe('200000000');

    const recon = await ctx.pool.query(
      `SELECT asset_id::text, minted_matches_balances, circulating_matches_balances,
              transferred_matches_sent, transferred_matches_received,
              user_count_matches_balances
       FROM ledger_accounting_reconciliation WHERE asset_id IN ($1::uuid, $2::uuid)`,
      [asset.id, DEFAULT_ASSET_ID],
    );
    for (const row of recon.rows) {
      expect(row, JSON.stringify(row)).toMatchObject({
        minted_matches_balances: true,
        circulating_matches_balances: true,
        transferred_matches_sent: true,
        transferred_matches_received: true,
        // Buyer/seller getting their first balance row in the base/quote
        // asset must bump per-asset user_count so this stays true. Before
        // the fix this would silently drift below balance_row_count.
        user_count_matches_balances: true,
      });
    }

    // Now buyer rests a buy-side limit, seller takes it (sell-taker case)
    // — this is the path that previously minted `fee` quote tokens out
    // of thin air.
    const buyMaker = {
      market_id: market.id,
      side: 'buy',
      order_type: 'limit',
      price_quote_base_units: (5n * ONE).toString(),
      base_amount_base_units: (1n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buyMakerRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buyMaker),
    });
    expect(buyMakerRes.statusCode).toBe(200);
    expect(buyMakerRes.json().order.status).toBe('open');

    const sellTaker = {
      market_id: market.id,
      side: 'sell',
      order_type: 'market',
      base_amount_base_units: (1n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const sellTakerRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sellTaker),
    });
    expect(sellTakerRes.statusCode).toBe(200);
    expect(sellTakerRes.json().fee_base_units).toBe('50000000');
    expect(sellTakerRes.json().received_quote_base_units).toBe('4950000000');

    const recon2 = await ctx.pool.query(
      `SELECT asset_id, minted_matches_balances, circulating_matches_balances,
              transferred_matches_sent, transferred_matches_received
       FROM ledger_accounting_reconciliation WHERE asset_id IN ($1::uuid, $2::uuid)`,
      [asset.id, DEFAULT_ASSET_ID],
    );
    for (const row of recon2.rows) {
      expect(row.minted_matches_balances).toBe(true);
      expect(row.circulating_matches_balances).toBe(true);
      expect(row.transferred_matches_sent).toBe(true);
      expect(row.transferred_matches_received).toBe(true);
    }
  });

  it('rejects orders whose math would overflow pg bigint with BAD_REQUEST', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    const { market } = await launchMarket(ctx, launcher);

    const huge = '999999999999999999';
    const body = {
      market_id: market.id,
      side: 'buy',
      order_type: 'limit',
      price_quote_base_units: huge,
      base_amount_base_units: huge,
      client_order_id: randomUUID(),
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, body),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('releases excess quote reservation when a limit buy fills below its limit price', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);

    await fundAsset(ctx, asset.id, seller.publicKeyBase58, 4n * ONE);
    await fundAsset(ctx, DEFAULT_ASSET_ID, buyer.publicKeyBase58, 50n * ONE);

    // Seller rests 4 base at 2 quote/base.
    const sell = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: (2n * ONE).toString(),
      base_amount_base_units: (4n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const sellRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sell),
    });
    expect(sellRes.statusCode).toBe(200);

    // Buyer bids for 10 base at 5 quote/base. The first 4 fill at 2, and
    // the remaining 6 rest at 5. Only 30 quote should stay locked for the
    // resting size; the 12 quote improvement should return to spendable.
    const buy = {
      market_id: market.id,
      side: 'buy',
      order_type: 'limit',
      price_quote_base_units: (5n * ONE).toString(),
      base_amount_base_units: (10n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buyRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buy),
    });
    expect(buyRes.statusCode).toBe(200);
    const buyJson = buyRes.json();
    expect(buyJson.order.status).toBe('partially_filled');
    expect(buyJson.order.remaining_base_units).toBe((6n * ONE).toString());
    expect(buyJson.order.reserved_remaining_base_units).toBe((30n * ONE).toString());

    const bal = await ctx.pool.query<{ spendable: string; locked: string }>(
      `SELECT spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [DEFAULT_ASSET_ID, buyer.publicKeyBase58],
    );
    expect(bal.rows[0]).toMatchObject({
      spendable: (12n * ONE).toString(),
      locked: (30n * ONE).toString(),
    });
  });

  it('exposes the 24h open price after a trade for client-side change calc', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const buyer = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);
    await fundAsset(ctx, asset.id, seller.publicKeyBase58, 5n * ONE);
    await fundAsset(ctx, DEFAULT_ASSET_ID, buyer.publicKeyBase58, 10n * ONE);

    // Before any trades the field is absent.
    const before = await ctx.app.inject({ method: 'GET', url: '/markets' });
    expect(before.statusCode).toBe(200);
    const beforeMarket = before.json().markets.find((m: any) => m.id === market.id);
    expect(beforeMarket.open_price_24h_quote_base_units).toBeUndefined();
    expect(beforeMarket.last_price_quote_base_units).toBeUndefined();

    // Seller posts; buyer takes; market now has trade history.
    const sell = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: (2n * ONE).toString(),
      base_amount_base_units: (1n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const sellRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, sell),
    });
    expect(sellRes.statusCode).toBe(200);
    const buy = {
      market_id: market.id,
      side: 'buy',
      order_type: 'market',
      base_amount_base_units: (1n * ONE).toString(),
      max_quote_base_units: (3n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const buyRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: buyer.cookie, 'content-type': 'application/json' },
      payload: orderBody(buyer, buy),
    });
    expect(buyRes.statusCode).toBe(200);

    const after = await ctx.app.inject({ method: 'GET', url: '/markets' });
    const afterMarket = after.json().markets.find((m: any) => m.id === market.id);
    expect(afterMarket.open_price_24h_quote_base_units).toBe((2n * ONE).toString());
    expect(afterMarket.last_price_quote_base_units).toBe((2n * ONE).toString());
  });

  it('refuses to cancel an order owned by someone else with ORDER_NOT_FOUND', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const stranger = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);
    await fundAsset(ctx, asset.id, seller.publicKeyBase58, ONE);

    const body = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: ONE.toString(),
      base_amount_base_units: ONE.toString(),
      client_order_id: randomUUID(),
    };
    const orderRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, body),
    });
    expect(orderRes.statusCode).toBe(200);
    const orderId = orderRes.json().order.id;

    const cancelBody = { market_id: market.id, order_id: orderId };
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders/${orderId}/cancel`,
      headers: { cookie: stranger.cookie, 'content-type': 'application/json' },
      payload: {
        ...cancelBody,
        client_signature_base58: stranger.sign('market.order.cancel', cancelBody),
      },
    });
    expect(cancel.statusCode).toBe(404);
    expect(cancel.json().error).toBe('ORDER_NOT_FOUND');
  });

  it('cancels an open order and releases locked funds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const launcher = await loginAsRandomWallet(ctx.app);
    const seller = await loginAsRandomWallet(ctx.app);
    const { asset, market } = await launchMarket(ctx, launcher);
    await fundAsset(ctx, asset.id, seller.publicKeyBase58, 3n * ONE);

    const body = {
      market_id: market.id,
      side: 'sell',
      order_type: 'limit',
      price_quote_base_units: ONE.toString(),
      base_amount_base_units: (3n * ONE).toString(),
      client_order_id: randomUUID(),
    };
    const orderRes = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: orderBody(seller, body),
    });
    expect(orderRes.statusCode).toBe(200);
    const orderId = orderRes.json().order.id;
    const cancelBody = { market_id: market.id, order_id: orderId };
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/markets/${market.id}/orders/${orderId}/cancel`,
      headers: { cookie: seller.cookie, 'content-type': 'application/json' },
      payload: {
        ...cancelBody,
        client_signature_base58: seller.sign('market.order.cancel', cancelBody),
      },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().released_base_units).toBe((3n * ONE).toString());

    const bal = await ctx.pool.query<{ spendable: string; locked: string }>(
      `SELECT spendable_base_units::text AS spendable, locked_base_units::text AS locked
       FROM account_balances WHERE asset_id=$1::uuid AND pubkey=$2`,
      [asset.id, seller.publicKeyBase58],
    );
    expect(bal.rows[0]).toMatchObject({ spendable: (3n * ONE).toString(), locked: '0' });
  });
});
