import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

// Test fixture (see helpers.ts):
//   difficultyStartBits=8, mintMaxSupply=21 (RPOW), baseRewardBaseUnits=7_812_500,
//   halvingIntervalBlocks=1_000_000, difficultyStepBlocks=1_000_000.
// 1 RPOW = 1_000_000_000 base units. The huge halving and difficulty-step
// intervals mean the test fixture stays in tier 0 throughout: every mint
// earns 7_812_500 base units at 8 trailing-zero bits.

const RPOW = 1_000_000_000n;
const MAX_SUPPLY_BU = 21n * RPOW;

describe('GET /ledger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('public, no auth, returns counters and schedule info in base units', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/ledger' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      total_minted_base_units: '0',
      total_transferred_base_units: '0',
      circulating_supply_base_units: '0',
      minted_supply_counter_base_units: '0',
      max_supply_base_units: MAX_SUPPLY_BU.toString(),
      base_units_per_rpow: RPOW.toString(),

      block_height: '0',
      halving_interval_blocks: 1_000_000,
      difficulty_step_blocks: 1_000_000,
      difficulty_max_bits: 50,

      current_difficulty_bits: 8,
      next_difficulty_bits: 9,
      next_difficulty_at_block: '1000000',
      blocks_to_next_difficulty_step: '1000000',
      difficulty_tier: 0,

      current_reward_base_units: '7812500',
      next_reward_base_units: '3906250',
      next_halving_at_block: '1000000',
      blocks_to_next_halving: '1000000',
      halving_index: 0,

      is_capped: false,
      // user_count tracks (asset_id, pubkey) rows in account_balances so the
      // ledger_accounting_reconciliation invariant `user_count = balance_row_count`
      // holds. The treasury seat is seeded at migration time, so a fresh DB
      // starts at 1 here.
      user_count: 1,
    });
  });

  it('serves ledger stats with ETag validators', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const first = await ctx.app.inject({ method: 'GET', url: '/ledger/stats' });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBeTruthy();

    const second = await ctx.app.inject({
      method: 'GET',
      url: '/ledger/stats',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('invalidates cached ledger stats immediately after mint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const first = await ctx.app.inject({ method: 'GET', url: '/ledger' });
    expect(first.statusCode).toBe(200);
    expect(first.json().total_minted_base_units).toBe('0');
    const firstEvents = await ctx.app.inject({ method: 'GET', url: '/ledger/events' });
    expect(firstEvents.json().events).toEqual([]);

    const w = await loginAsRandomWallet(ctx.app);
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json() as {
      challenge_id: string;
      nonce_prefix: string;
      difficulty_bits: number;
      issued_at: string;
      expires_at: string;
      challenge_mac: string;
    };
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const signed = { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() };
    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: {
        ...ch,
        solution_nonce: nonce.toString(),
        client_signature_base58: w.sign('mint', signed),
      },
    });
    expect(mint.statusCode).toBe(200);

    const second = await ctx.app.inject({ method: 'GET', url: '/ledger' });
    expect(second.json().total_minted_base_units).toBe('7812500');
    const secondEvents = await ctx.app.inject({ method: 'GET', url: '/ledger/events' });
    expect(secondEvents.json().events[0]).toMatchObject({
      type: 'mint',
      actor_pubkey: w.publicKeyBase58,
      amount_base_units: '7812500',
    });
  });

  it('reports growing supply as tokens + counter are seeded', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Keep maintained stats in sync with the seeded supply (server's /mint
    // path updates both; tests inject directly so we mirror it).
    await ctx.pool.query(
      `UPDATE app_counters SET value = $1 WHERE name = 'minted_supply'`,
      [(12n * RPOW).toString()],
    );
    await ctx.pool.query(
      `UPDATE ledger_stats SET value = $1 WHERE name = 'circulating_supply'`,
      [(12n * RPOW).toString()],
    );

    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.total_minted_base_units).toBe((12n * RPOW).toString());
    expect(body.circulating_supply_base_units).toBe((12n * RPOW).toString());
    expect(body.minted_supply_counter_base_units).toBe((12n * RPOW).toString());
    // Block height is independent of the supply rewrite this test does.
    expect(body.block_height).toBe('0');
    // Block-based schedule: still tier 0 (test step is 1M blocks).
    expect(body.halving_index).toBe(0);
    expect(body.current_reward_base_units).toBe('7812500');
    expect(body.current_difficulty_bits).toBe(8);
    expect(body.next_halving_at_block).toBe('1000000');
    expect(body.blocks_to_next_halving).toBe('1000000');
    expect(body.is_capped).toBe(false);
  });

  it('reports is_capped at maxSupply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `UPDATE app_counters SET value = $1 WHERE name = 'minted_supply'`,
      [MAX_SUPPLY_BU.toString()],
    );
    await ctx.pool.query(
      `UPDATE ledger_stats SET value = $1 WHERE name = 'circulating_supply'`,
      [MAX_SUPPLY_BU.toString()],
    );

    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.total_minted_base_units).toBe(MAX_SUPPLY_BU.toString());
    expect(body.minted_supply_counter_base_units).toBe(MAX_SUPPLY_BU.toString());
    expect(body.is_capped).toBe(true);
  });

  it('serves /ledger/events from the durable partitioned ledger when hot cache is empty', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const eventId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO ledger_events(id, event_type, actor_pubkey, amount)
       VALUES($1, 'MINT', $2, $3)`,
      [eventId, 'actor-pubkey-for-test', '123'],
    );

    const res = await ctx.app.inject({ method: 'GET', url: '/ledger/events?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events[0]).toMatchObject({
      id: eventId,
      type: 'mint',
      actor_pubkey: 'actor-pubkey-for-test',
      amount_base_units: '123',
    });
  });
});
