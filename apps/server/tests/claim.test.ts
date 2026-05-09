import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';

const ONE_RPOW = 1_000_000_000n;

/** Seed spendable balance directly — no need for full mining flow in unit tests. */
async function seedBalance(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  pubkey: string,
  amount: bigint,
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO account_balances(pubkey, spendable_base_units, updated_at)
     VALUES($1, $2, now())
     ON CONFLICT (pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       updated_at = now()`,
    [pubkey, amount.toString()],
  );
}

function createBody(
  sender: TestWallet,
  amount_base_units: bigint,
  opts: { memo?: string; claim_id?: string } = {},
) {
  const claim_id = opts.claim_id ?? randomUUID();
  const body: Record<string, string> = { claim_id, amount_base_units: amount_base_units.toString() };
  if (opts.memo) body.memo = opts.memo;
  return { ...body, client_signature_base58: sender.sign('claim.create', body) };
}

async function postCreate(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  sender: TestWallet,
  amount: bigint,
  opts: { memo?: string; claim_id?: string } = {},
) {
  return ctx.app.inject({
    method: 'POST', url: '/claim',
    headers: { cookie: sender.cookie, 'content-type': 'application/json' },
    payload: createBody(sender, amount, opts),
  });
}

async function postRedeem(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  redeemer: TestWallet,
  claim_id: string,
) {
  return ctx.app.inject({
    method: 'POST', url: `/claim/${claim_id}/redeem`,
    headers: { cookie: redeemer.cookie, 'content-type': 'application/json' },
    payload: {},
  });
}

async function postCancel(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  sender: TestWallet,
  claim_id: string,
) {
  const sig = sender.sign('claim.cancel', { claim_id });
  return ctx.app.inject({
    method: 'POST', url: `/claim/${claim_id}/cancel`,
    headers: { cookie: sender.cookie, 'content-type': 'application/json' },
    payload: { client_signature_base58: sig },
  });
}

async function getStatus(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  claim_id: string,
) {
  return ctx.app.inject({ method: 'GET', url: `/claim/${claim_id}` });
}

async function getBalance(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  wallet: TestWallet,
): Promise<bigint> {
  const r = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: wallet.cookie } });
  return BigInt(r.json().balance_base_units);
}

describe('POST /claim', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('creates a claim and debits sender immediately', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const r = await postCreate(ctx, sender, ONE_RPOW);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.amount_base_units).toBe(ONE_RPOW.toString());

    // Balance should be zero immediately after creation.
    expect(await getBalance(ctx, sender)).toBe(0n);
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const claim_id = randomUUID();
    const r = await ctx.app.inject({
      method: 'POST', url: '/claim',
      headers: { 'content-type': 'application/json' },
      payload: { claim_id, amount_base_units: ONE_RPOW.toString(), client_signature_base58: 'x'.repeat(80) },
    });
    expect(r.statusCode).toBe(401);
  });

  it('400 INSUFFICIENT_BALANCE when sender cannot cover the amount', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW / 2n);

    const r = await postCreate(ctx, sender, ONE_RPOW);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('401 INVALID_SIGNATURE on wrong sig', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const claim_id = randomUUID();
    const r = await ctx.app.inject({
      method: 'POST', url: '/claim',
      headers: { cookie: sender.cookie, 'content-type': 'application/json' },
      payload: {
        claim_id,
        amount_base_units: ONE_RPOW.toString(),
        client_signature_base58: 'A'.repeat(88), // bogus sig
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('INVALID_SIGNATURE');
  });

  it('accepts optional memo', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const r = await postCreate(ctx, sender, ONE_RPOW, { memo: 'birthday gift' });
    expect(r.statusCode).toBe(200);
    expect(r.json().memo).toBe('birthday gift');
  });

  it('409 DUPLICATE_CLAIM_ID when the same UUID is reused', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, 3n * ONE_RPOW);

    const claim_id = randomUUID();
    const r1 = await postCreate(ctx, sender, ONE_RPOW, { claim_id });
    expect(r1.statusCode).toBe(200);

    const r2 = await postCreate(ctx, sender, ONE_RPOW, { claim_id });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('DUPLICATE_CLAIM_ID');
  });
});

describe('GET /claim/:id', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns claim details publicly', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW, { memo: 'public check' });
    const { claim_id } = cr.json();

    const r = await getStatus(ctx, claim_id);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.claim_id).toBe(claim_id);
    expect(body.amount_base_units).toBe(ONE_RPOW.toString());
    expect(body.memo).toBe('public check');
    expect(body.state).toBe('pending');
    // Sender pubkey should NOT be exposed.
    expect(body.sender_pubkey).toBeUndefined();
  });

  it('404 for unknown UUID', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await getStatus(ctx, randomUUID());
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /claim/:id/redeem', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('happy path: credits redeemer and shows in activity', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const redeemer = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();

    const before = await getBalance(ctx, redeemer);
    const r = await postRedeem(ctx, redeemer, claim_id);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.amount_base_units).toBe(ONE_RPOW.toString());
    expect(body.transfer_id).toMatch(/^[0-9a-f-]{36}$/);

    // Redeemer balance increases.
    expect(await getBalance(ctx, redeemer)).toBe(before + ONE_RPOW);

    // Claim is now marked redeemed.
    const status = (await getStatus(ctx, claim_id)).json();
    expect(status.state).toBe('redeemed');
    expect(status.redeemed_at).toBeDefined();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({
      method: 'POST', url: `/claim/${randomUUID()}/redeem`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });

  it('409 ALREADY_REDEEMED on double redemption', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const reedemerA = await loginAsRandomWallet(ctx.app);
    const redeemerB = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();

    await postRedeem(ctx, reedemerA, claim_id);
    const r2 = await postRedeem(ctx, redeemerB, claim_id);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('ALREADY_REDEEMED');
  });

  it('400 BAD_REQUEST when sender tries to redeem their own claim', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();

    const r = await postRedeem(ctx, sender, claim_id);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('BAD_REQUEST');
  });

  it('409 CLAIM_CANCELLED when trying to redeem a cancelled claim', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const redeemer = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();
    await postCancel(ctx, sender, claim_id);

    const r = await postRedeem(ctx, redeemer, claim_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('CLAIM_CANCELLED');
  });

  it('shows as send in sender activity and receive in redeemer activity', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const redeemer = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();
    await postRedeem(ctx, redeemer, claim_id);

    // Wait a tick for hot table propagation.
    await new Promise((r) => setTimeout(r, 50));

    const senderActivity = (await ctx.app.inject({
      method: 'GET', url: '/activity?type=send',
      headers: { cookie: sender.cookie },
    })).json();
    expect(senderActivity.items.some((e: { type: string }) => e.type === 'send')).toBe(true);

    const redeemerActivity = (await ctx.app.inject({
      method: 'GET', url: '/activity?type=receive',
      headers: { cookie: redeemer.cookie },
    })).json();
    expect(redeemerActivity.items.some((e: { type: string }) => e.type === 'receive')).toBe(true);
  });
});

describe('POST /claim/:id/cancel', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('refunds sender and marks claim cancelled', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();
    expect(await getBalance(ctx, sender)).toBe(0n);

    const r = await postCancel(ctx, sender, claim_id);
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(await getBalance(ctx, sender)).toBe(ONE_RPOW);

    const status = (await getStatus(ctx, claim_id)).json();
    expect(status.state).toBe('cancelled');
    expect(status.cancelled_at).toBeDefined();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({
      method: 'POST', url: `/claim/${randomUUID()}/cancel`,
      headers: { 'content-type': 'application/json' },
      payload: { client_signature_base58: 'x'.repeat(88) },
    });
    expect(r.statusCode).toBe(401);
  });

  it('403 FORBIDDEN when non-sender tries to cancel', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const attacker = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();

    const r = await postCancel(ctx, attacker, claim_id);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('FORBIDDEN');
    // Claim is still pending.
    expect((await getStatus(ctx, claim_id)).json().state).toBe('pending');
  });

  it('401 INVALID_SIGNATURE on bad cancel sig', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();

    const r = await ctx.app.inject({
      method: 'POST', url: `/claim/${claim_id}/cancel`,
      headers: { cookie: sender.cookie, 'content-type': 'application/json' },
      payload: { client_signature_base58: 'A'.repeat(88) },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('INVALID_SIGNATURE');
  });

  it('409 ALREADY_CANCELLED on double cancel', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();
    await postCancel(ctx, sender, claim_id);

    const r = await postCancel(ctx, sender, claim_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('ALREADY_CANCELLED');
  });

  it('409 ALREADY_REDEEMED when trying to cancel an already-redeemed claim', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const redeemer = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, sender.publicKeyBase58, ONE_RPOW);

    const cr = await postCreate(ctx, sender, ONE_RPOW);
    const { claim_id } = cr.json();
    await postRedeem(ctx, redeemer, claim_id);

    const r = await postCancel(ctx, sender, claim_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('ALREADY_REDEEMED');
  });
});

describe('GET /claim (my claims)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('lists sender claims only', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedBalance(ctx, a.publicKeyBase58, 3n * ONE_RPOW);

    await postCreate(ctx, a, ONE_RPOW, { memo: 'first' });
    await postCreate(ctx, a, ONE_RPOW, { memo: 'second' });

    const r = await ctx.app.inject({ method: 'GET', url: '/claim', headers: { cookie: a.cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.claims).toHaveLength(2);

    // B sees no claims.
    const rb = await ctx.app.inject({ method: 'GET', url: '/claim', headers: { cookie: b.cookie } });
    expect(rb.json().claims).toHaveLength(0);
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/claim' });
    expect(r.statusCode).toBe(401);
  });
});
