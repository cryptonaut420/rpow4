import { describe, it, expect, afterEach } from 'vitest';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';

// In test config, mintMaxSupply = 21 RPOW => cap in base units = 21 * 10^9.
const ONE_RPOW = 1_000_000_000n;
const CAP_BASE_UNITS = 21n * ONE_RPOW;

// Set app_counters.minted_supply directly. /challenge reads supply from there
// (cached for 5s) to fail-fast at the cap.
async function setMintedSupplyBaseUnits(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  baseUnits: bigint,
) {
  await ctx.pool.query(
    `UPDATE app_counters SET value = $1::bigint WHERE name='minted_supply'`,
    [baseUnits.toString()],
  );
}

describe('POST /challenge', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('issues a stateless challenge to a logged-in wallet (no DB row)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.nonce_prefix).toMatch(/^[0-9a-f]+$/);
    expect(body.difficulty_bits).toBe(8);
    expect(body.issued_at).toBeTruthy();
    expect(body.expires_at).toBeTruthy();
    expect(body.challenge_mac).toMatch(/^[0-9a-f]{64}$/);
    // Statelessness check post-014: the legacy `challenges` table is
    // gone, so the only way to confirm /challenge writes nothing is by
    // shape (no follow-up DB lookup is possible). The MAC is the proof
    // of authenticity instead of a DB row.
  });

  it('rejects unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge' });
    expect(res.statusCode).toBe(401);
  });

  it('stamps the start-of-schedule difficulty while block_height is below the first step', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const a = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json();
    expect(a.difficulty_bits).toBe(8);
    // Bumping minted_supply does not advance difficulty in the block-based
    // schedule. Difficulty advances with block_height (mint count), which
    // the test fixture sets a giant step-blocks for, so it stays at 8.
    // (The block-height-driven step is unit-tested in schedule.test.ts;
    // wiring it through the route would require waiting out the 5-second
    // counter cache, which isn't worth the flake.)
    await setMintedSupplyBaseUnits(ctx, 10n * ONE_RPOW);
    const b = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json();
    expect(b.difficulty_bits).toBe(8);
  });

  it('refuses with 410 SUPPLY_EXHAUSTED at cap', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
  });
});
