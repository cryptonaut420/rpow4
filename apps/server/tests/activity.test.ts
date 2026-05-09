import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loginAsRandomWallet, makeTestApp, type TestWallet } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, w: TestWallet, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie: w.cookie } })).json() as {
      challenge_id: string;
      nonce_prefix: string;
      difficulty_bits: number;
      issued_at: string;
      expires_at: string;
      challenge_mac: string;
    };
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const body = { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() };
    await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie: w.cookie, 'content-type': 'application/json' },
      payload: {
        challenge_id: ch.challenge_id,
        nonce_prefix: ch.nonce_prefix,
        difficulty_bits: ch.difficulty_bits,
        issued_at: ch.issued_at,
        expires_at: ch.expires_at,
        challenge_mac: ch.challenge_mac,
        solution_nonce: nonce.toString(),
        client_signature_base58: w.sign('mint', body),
      },
    });
  }
}

describe('GET /activity', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('shows mint, send, receive entries with counterparty_pubkey + client_signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAsRandomWallet(ctx.app);
    const b = await loginAsRandomWallet(ctx.app);
    await mineN(ctx, a, 2);
    // Each mint credits 7,812,500 base units; send one full token's worth so
    // the exact-sum lock can pick a single token.
    const sendBody = {
      recipient_pubkey: b.publicKeyBase58,
      amount_base_units: '7812500',
      idempotency_key: randomUUID(),
    };
    const r = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: { ...sendBody, client_signature_base58: a.sign('transfer', sendBody) },
    });
    expect(r.statusCode).toBe(200);

    const aAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a.cookie } })).json() as Array<any>;
    const bAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: b.cookie } })).json() as Array<any>;

    expect(aAct.find((e) => e.type === 'mint')).toBeTruthy();
    const sent = aAct.find((e) => e.type === 'send' && e.counterparty_pubkey === b.publicKeyBase58);
    expect(sent).toBeTruthy();
    expect(sent.client_signature_base58).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);

    const received = bAct.find((e) => e.type === 'receive' && e.counterparty_pubkey === a.publicKeyBase58);
    expect(received).toBeTruthy();
    expect(received.client_signature_base58).toBe(sent.client_signature_base58);

    const hot = await ctx.pool.query(
      `SELECT pubkey, type, count(*)::int AS n
       FROM account_recent_events
       WHERE pubkey IN ($1, $2)
       GROUP BY pubkey, type`,
      [a.publicKeyBase58, b.publicKeyBase58],
    );
    expect(hot.rows.some((r) => r.pubkey === a.publicKeyBase58 && r.type === 'mint')).toBe(true);
    expect(hot.rows.some((r) => r.pubkey === a.publicKeyBase58 && r.type === 'send')).toBe(true);
    expect(hot.rows.some((r) => r.pubkey === b.publicKeyBase58 && r.type === 'receive')).toBe(true);
  });

  it('fills activity from partitioned history when hot rows are sparse', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const w = await loginAsRandomWallet(ctx.app);
    const oldId = randomUUID();
    const hotId = randomUUID();

    const oldEvent = await ctx.pool.query<{ event_seq: string }>(
      `INSERT INTO ledger_events(id, event_type, actor_pubkey, amount, created_at)
       VALUES($1, 'MINT', $2, 11, now() - interval '1 minute')
       RETURNING event_seq::text AS event_seq`,
      [oldId, w.publicKeyBase58],
    );
    const hotEvent = await ctx.pool.query<{ event_seq: string }>(
      `INSERT INTO ledger_events(id, event_type, actor_pubkey, amount, created_at)
       VALUES($1, 'MINT', $2, 22, now())
       RETURNING event_seq::text AS event_seq`,
      [hotId, w.publicKeyBase58],
    );
    await ctx.pool.query(
      `INSERT INTO account_recent_events(pubkey, event_seq, type, amount, created_at)
       VALUES($1, $2, 'mint', 22, now())`,
      [w.publicKeyBase58, hotEvent.rows[0]!.event_seq],
    );

    const activity = (
      await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: w.cookie } })
    ).json() as Array<any>;

    expect(activity.map((e) => e.amount_base_units)).toEqual(['22', '11']);
    expect(activity.length).toBe(2);
    expect(BigInt(hotEvent.rows[0]!.event_seq)).toBeGreaterThan(BigInt(oldEvent.rows[0]!.event_seq));
  });
});
