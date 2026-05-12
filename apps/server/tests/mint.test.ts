import { describe, it, expect, afterEach } from 'vitest';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

// In the test fixture, baseRewardBaseUnits=7_812_500 and the
// halving/difficulty step intervals are pushed to 1_000_000 blocks each
// — the schedule stays in tier 0 throughout the test suite. Every
// successful mint credits 7,812,500 base units.
const REWARD_BASE_UNITS = 7_812_500n;
const ONE_RPOW = 1_000_000_000n;
const CAP_BASE_UNITS = 21n * ONE_RPOW;

async function getChallenge(ctx: Awaited<ReturnType<typeof makeTestApp>>, w: TestWallet) {
  const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json();
  return ch as {
    challenge_id: string;
    nonce_prefix: string;
    difficulty_bits: number;
    issued_at: string;
    expires_at: string;
    challenge_mac: string;
  };
}

function mintBody(
  w: TestWallet,
  ch: {
    challenge_id: string;
    nonce_prefix: string;
    difficulty_bits: number;
    issued_at: string;
    expires_at: string;
    challenge_mac: string;
  },
  nonce: bigint,
) {
  const body = { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() };
  return {
    challenge_id: ch.challenge_id,
    nonce_prefix: ch.nonce_prefix,
    difficulty_bits: ch.difficulty_bits,
    issued_at: ch.issued_at,
    expires_at: ch.expires_at,
    challenge_mac: ch.challenge_mac,
    solution_nonce: nonce.toString(),
    client_signature_base58: w.sign('mint', body),
  };
}

async function setMintedSupplyBaseUnits(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  baseUnits: bigint,
) {
  await ctx.pool.query(
    `UPDATE app_counters SET value = $1::bigint WHERE name='minted_supply'`,
    [baseUnits.toString()],
  );
}

describe('POST /mint', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits a token on a valid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const ch = await getChallenge(ctx, w);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: mintBody(w, ch, nonce),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.value_base_units).toBe(REWARD_BASE_UNITS.toString());
    const tokenId = res.json().token.id;
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: w.cookie } })).json();
    expect(me.balance_base_units).toBe(REWARD_BASE_UNITS.toString());
    expect(me.minted_base_units).toBe(REWARD_BASE_UNITS.toString());

    const sidecar = await ctx.pool.query(
      `SELECT e.event_seq, ids.event_seq AS id_event_seq, claims.event_seq AS claim_event_seq
       FROM ledger_events e
       JOIN ledger_event_ids ids ON ids.id = e.id
       JOIN ledger_mint_claims claims ON claims.challenge_id = e.challenge_id
       WHERE e.id=$1`,
      [tokenId],
    );
    expect(sidecar.rowCount).toBe(1);
    expect(sidecar.rows[0].id_event_seq).toBe(sidecar.rows[0].event_seq);
    expect(sidecar.rows[0].claim_event_seq).toBe(sidecar.rows[0].event_seq);
  });

  it('rejects invalid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const ch = await getChallenge(ctx, w);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: mintBody(w, ch, 0n),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SOLUTION');
  });

  it('rejects a missing/invalid client signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const ch = await getChallenge(ctx, w);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const goodBody = mintBody(w, ch, nonce);
    // Tamper with the signature.
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: { ...goodBody, client_signature_base58: '1'.repeat(88) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_SIGNATURE');
  });

  it('rejects double-claim of same challenge', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const ch = await getChallenge(ctx, w);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const body = mintBody(w, ch, nonce);
    const first = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie: w.cookie, 'content-type': 'application/json' }, payload: body });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie: w.cookie, 'content-type': 'application/json' }, payload: body });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('CHALLENGE_ALREADY_CLAIMED');
  });

  it('refuses with 410 SUPPLY_EXHAUSTED when cap is reached between challenge and mint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const ch = await getChallenge(ctx, w);
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: mintBody(w, ch, nonce),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
  });

  it('serializes concurrent mints at the cap boundary so only one succeeds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS - REWARD_BASE_UNITS);

    const wallets: TestWallet[] = [];
    const challenges: Array<Awaited<ReturnType<typeof getChallenge>>> = [];
    for (let i = 0; i < 5; i++) {
      const w = await loginAsRandomWallet(ctx.app);
      wallets.push(w);
      challenges.push(await getChallenge(ctx, w));
    }

    const nonces = challenges.map((ch) =>
      findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits),
    );

    const results = await Promise.all(
      challenges.map((ch, i) =>
        ctx.app.inject({
          method: 'POST', url: '/mint',
          headers: { cookie: wallets[i]!.cookie, 'content-type': 'application/json' },
          payload: mintBody(wallets[i]!, ch, nonces[i]!),
        }),
      ),
    );

    const successes = results.filter((r) => r.statusCode === 200);
    const exhausted = results.filter((r) => r.statusCode === 410 && r.json().error === 'SUPPLY_EXHAUSTED');
    expect(successes.length).toBe(1);
    expect(exhausted.length).toBe(4);
  });
});
