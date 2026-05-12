import { afterEach, describe, expect, it } from 'vitest';
import { loginAsRandomWallet, makeTestApp } from './helpers.js';

describe('news posts', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('allows only admins to publish markdown news posts', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const admin = await loginAsRandomWallet(ctx.app);
    const user = await loginAsRandomWallet(ctx.app);

    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/news',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: { title: 'Not allowed', body_markdown: 'nope' },
    });
    expect(denied.statusCode).toBe(403);

    await ctx.pool.query(`UPDATE accounts SET is_admin = TRUE WHERE pubkey=$1`, [admin.publicKeyBase58]);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/news',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      payload: {
        title: 'Markets launch notes',
        summary: 'A short release note.',
        kind: 'changelog',
        body_markdown: '## Changes\n\n- Added `markets`.',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().post.slug).toBe('markets-launch-notes');

    const list = await ctx.app.inject({ method: 'GET', url: '/news' });
    expect(list.statusCode).toBe(200);
    expect(list.json().posts).toHaveLength(1);
    expect(list.json().posts[0].kind).toBe('changelog');
  });
});
