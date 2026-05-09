import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';

async function seedToken(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  ownerPubkey: string,
  valueBaseUnits: bigint,
): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO account_balances(pubkey, spendable_base_units, updated_at)
     VALUES($1, $2, now())
     ON CONFLICT (pubkey) DO UPDATE SET
       spendable_base_units = account_balances.spendable_base_units + EXCLUDED.spendable_base_units,
       updated_at = now()`,
    [ownerPubkey, valueBaseUnits.toString()],
  );
  await ctx.pool.query(
    `UPDATE ledger_stats
     SET value = value + $1::bigint, updated_at = now()
     WHERE name='circulating_supply'`,
    [valueBaseUnits.toString()],
  );
  return id;
}

function sendBody(
  sender: TestWallet,
  recipient_pubkey: string,
  amount_base_units: bigint,
  idempotency_key = randomUUID(),
) {
  const body = {
    recipient_pubkey,
    amount_base_units: amount_base_units.toString(),
    idempotency_key,
  };
  return { ...body, client_signature_base58: sender.sign('transfer', body) };
}

const ONE_RPOW = 1_000_000_000n;
const ONE_OVER_128 = 7_812_500n;

describe('POST /send', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('transfers tokens between two wallets', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, 2n * ONE_RPOW),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      transferred_base_units: (2n * ONE_RPOW).toString(),
      recipient_pubkey: b.publicKeyBase58,
    });
    const transferId = res.json().transfer_id;

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a.cookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: b.cookie } })).json();
    expect(aMe.balance_base_units).toBe(ONE_RPOW.toString());
    expect(bMe.balance_base_units).toBe((2n * ONE_RPOW).toString());

    const ledger = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(ledger.total_transferred_base_units).toBe((2n * ONE_RPOW).toString());

    const sidecar = await ctx.pool.query(
      `SELECT e.event_seq, ids.event_seq AS id_event_seq, idem.event_seq AS idem_event_seq
       FROM ledger_events e
       JOIN ledger_event_ids ids ON ids.id = e.id
       JOIN ledger_transfer_idempotency idem ON idem.event_id = e.id
       WHERE e.id=$1`,
      [transferId],
    );
    expect(sidecar.rowCount).toBe(1);
    expect(sidecar.rows[0].id_event_seq).toBe(sidecar.rows[0].event_seq);
    expect(sidecar.rows[0].idem_event_seq).toBe(sidecar.rows[0].event_seq);
  });

  it('lazily creates the recipient account if it does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    // Recipient pubkey that has never authenticated. Generate a fresh kp
    // without logging in so no accounts row exists yet.
    const b = await loginAsRandomWallet(ctx.app);
    await ctx.pool.query('DELETE FROM accounts WHERE pubkey=$1', [b.publicKeyBase58]);

    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, ONE_RPOW),
    });
    expect(res.statusCode).toBe(200);

    const acct = await ctx.pool.query('SELECT pubkey FROM accounts WHERE pubkey=$1', [b.publicKeyBase58]);
    expect(acct.rowCount).toBe(1);
    // No "pending" flow exists in the new model — recipient just sees the balance on next /me.
    expect(res.json().pending).toBeUndefined();
  });

  it('fails on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, ONE_RPOW),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects a /send body with a tampered signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    const body = sendBody(a, b.publicKeyBase58, ONE_RPOW);
    const tampered = { ...body, client_signature_base58: '1'.repeat(88) };
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_SIGNATURE');
  });

  it('rejects same idempotency_key with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    const c = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    const key = randomUUID();
    const first = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, ONE_RPOW, key),
    });
    expect(first.statusCode).toBe(200);
    const conflict = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, c.publicKeyBase58, ONE_RPOW, key),
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('idempotency: same key returns same result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    const key = randomUUID();
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, ONE_RPOW, key),
    });
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, ONE_RPOW, key),
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().transfer_id).toBe(r2.json().transfer_id);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a.cookie } })).json();
    expect(aMe.balance_base_units).toBe(ONE_RPOW.toString()); // only one token transferred, not two
  });

  it('succeeds for arbitrary amounts without exact token denominations', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, 500_000_000n),
    });
    expect(res.statusCode).toBe(200);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a.cookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: b.cookie } })).json();
    expect(aMe.balance_base_units).toBe((2n * ONE_RPOW - 500_000_000n).toString());
    expect(bMe.balance_base_units).toBe('500000000');
  });

  it('succeeds when an exact combination exists across multiple denominations', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await seedToken(ctx, a.publicKeyBase58, ONE_RPOW);
    await seedToken(ctx, a.publicKeyBase58, ONE_OVER_128);
    const target = ONE_RPOW + ONE_OVER_128;
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: sendBody(a, b.publicKeyBase58, target),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transferred_base_units).toBe(target.toString());

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a.cookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: b.cookie } })).json();
    expect(aMe.balance_base_units).toBe('0');
    expect(bMe.balance_base_units).toBe(target.toString());
  });
});
