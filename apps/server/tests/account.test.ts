import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, loginAsWallet, makeTestApp } from './helpers.js';
import { generateMnemonic, mnemonicToKeypair } from '@rpow/shared';
import { findSolutionForTest } from '../src/pow.js';

async function setName(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  w: Awaited<ReturnType<typeof loginAsRandomWallet>>,
  display_name: string | null,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/me/display_name',
    headers: { cookie: w.cookie, 'content-type': 'application/json' },
    payload: {
      display_name,
      client_signature_base58: w.sign('account.set_display_name', { display_name }),
    },
  });
}

describe('POST /me/display_name', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({
      method: 'POST', url: '/me/display_name',
      headers: { 'content-type': 'application/json' },
      payload: { display_name: 'alice', client_signature_base58: 'x'.repeat(80) },
    });
    expect(r.statusCode).toBe(401);
  });

  it('sets a name and surfaces it on /me', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const r = await setName(ctx, w, 'Alice');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, display_name: 'Alice' });

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: w.cookie } })).json();
    expect(me.display_name).toBe('Alice');
  });

  it('rejects an invalid signature with 401 INVALID_SIGNATURE', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const r = await ctx.app.inject({
      method: 'POST', url: '/me/display_name',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: {
        display_name: 'alice',
        // sign over a *different* body so the canonical message mismatches
        client_signature_base58: w.sign('account.set_display_name', { display_name: 'someone-else' }),
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('INVALID_SIGNATURE');
  });

  it('clears the name when display_name=null', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    await setName(ctx, w, 'bob');
    const r = await setName(ctx, w, null);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, display_name: null });

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: w.cookie } })).json();
    expect(me.display_name).toBeNull();
  });

  it('rejects too-short, too-long, and invalid-charset names', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    for (const bad of ['ab', 'a'.repeat(33), 'has spaces', 'no#hash']) {
      const r = await setName(ctx, w, bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('BAD_REQUEST');
    }
  });

  it('rejects names with leading/trailing punctuation or doubled separators', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    for (const bad of ['.alice', 'alice.', '-alice', '_alice', 'al..ice', 'al--ice', 'al@@ice']) {
      const r = await setName(ctx, w, bad);
      expect(r.statusCode, `expected ${bad} to be rejected`).toBe(400);
      expect(r.json().error).toBe('BAD_REQUEST');
    }
  });

  it('rejects reserved handles (case-insensitively)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    for (const reserved of ['admin', 'Admin', 'ROOT', 'rpow', 'system', 'support']) {
      const r = await setName(ctx, w, reserved);
      expect(r.statusCode, `expected ${reserved} to be reserved`).toBe(400);
      expect(r.json().message).toMatch(/reserved/);
    }
  });

  it('allows reserved tokens when used as a substring (e.g. admin@example.com)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const r = await setName(ctx, w, 'admin@example.com');
    expect(r.statusCode).toBe(200);
  });

  it('rejects a duplicate name (case-insensitive) with 409 NAME_TAKEN', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    expect((await setName(ctx, a, 'Alice')).statusCode).toBe(200);

    const dup = await setName(ctx, b, 'alice');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('NAME_TAKEN');
  });

  it('lets a single user re-take the same name (idempotent same-pubkey update)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    expect((await setName(ctx, w, 'Alice')).statusCode).toBe(200);
    // Updating to the exact same value works (same row, no UNIQUE collision).
    expect((await setName(ctx, w, 'Alice')).statusCode).toBe(200);
    // Changing case for the same user should also work — they own the row.
    expect((await setName(ctx, w, 'ALICE')).statusCode).toBe(200);
  });
});

describe('GET /lookup/:name', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('resolves a known handle to its pubkey (case-insensitive)', async () => {
    const kp = mnemonicToKeypair(generateMnemonic());
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsWallet(ctx.app, kp);
    await setName(ctx, w, 'Alice');

    for (const variant of ['Alice', 'alice', 'ALICE']) {
      const r = await ctx.app.inject({ method: 'GET', url: `/lookup/${variant}` });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ pubkey: kp.publicKeyBase58, display_name: 'Alice' });
    }
  });

  it('returns 404 NAME_NOT_FOUND for unknown handles', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/lookup/nobody' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('NAME_NOT_FOUND');
  });

  it('does not require authentication', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    await setName(ctx, w, 'visible');
    const r = await ctx.app.inject({ method: 'GET', url: '/lookup/visible' });
    expect(r.statusCode).toBe(200);
  });
});

describe('GET /activity counterparty_display_name', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('joins each transfer counterparty to their current display_name', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sender = await loginAsRandomWallet(ctx.app);
    const recipient = await loginAsRandomWallet(ctx.app);
    await setName(ctx, recipient, 'BoB');

    // Mine one token so sender has tokens to ship.
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: sender.cookie } })).json() as {
      challenge_id: string;
      nonce_prefix: string;
      difficulty_bits: number;
      issued_at: string;
      expires_at: string;
      challenge_mac: string;
    };
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const mintBody = { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() };
    await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: sender.cookie, 'content-type': 'application/json' },
      payload: {
        challenge_id: ch.challenge_id,
        nonce_prefix: ch.nonce_prefix,
        difficulty_bits: ch.difficulty_bits,
        issued_at: ch.issued_at,
        expires_at: ch.expires_at,
        challenge_mac: ch.challenge_mac,
        solution_nonce: nonce.toString(),
        client_signature_base58: sender.sign('mint', mintBody),
      },
    });
    const sendBody = {
      recipient_pubkey: recipient.publicKeyBase58,
      amount_base_units: '7812500',
      idempotency_key: randomUUID(),
    };
    const sendRes = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: sender.cookie, 'content-type': 'application/json' },
      payload: { ...sendBody, client_signature_base58: sender.sign('transfer', sendBody) },
    });
    expect(sendRes.statusCode).toBe(200);

    const senderActivity = (
      await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: sender.cookie } })
    ).json() as Array<any>;
    const sendEvent = senderActivity.find((e) => e.type === 'send');
    expect(sendEvent.counterparty_pubkey).toBe(recipient.publicKeyBase58);
    expect(sendEvent.counterparty_display_name).toBe('BoB');

    // Updates to the recipient's display name should be reflected on
    // subsequent /activity reads — the join is computed at query time.
    await setName(ctx, recipient, 'Roberto');
    const senderActivity2 = (
      await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: sender.cookie } })
    ).json() as Array<any>;
    expect(senderActivity2.find((e) => e.type === 'send').counterparty_display_name).toBe('Roberto');
  });
});
