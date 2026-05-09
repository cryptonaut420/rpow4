import { describe, it, expect } from 'vitest';
import { withTxRetry } from '../src/db.js';
import type { Pool, PoolClient } from 'pg';

/**
 * Stub Pool/PoolClient just thorough enough for withTxRetry. We don't
 * exercise real Postgres here — the goal is to lock the retry-on-
 * deadlock behavior in.
 */
function fakePool(): Pool {
  const client: Partial<PoolClient> = {
    query: (async () => ({ rows: [], rowCount: 0 } as any)) as any,
    release: () => undefined,
  };
  return {
    connect: async () => client as PoolClient,
  } as unknown as Pool;
}

class PgError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

describe('withTxRetry', () => {
  it('retries on deadlock_detected (40P01) and eventually succeeds', async () => {
    let attempts = 0;
    const pool = fakePool();
    const result = await withTxRetry(pool, async () => {
      attempts += 1;
      if (attempts < 3) throw new PgError('40P01');
      return 'ok';
    }, { baseDelayMs: 0 });
    expect(attempts).toBe(3);
    expect(result).toBe('ok');
  });

  it('retries on serialization_failure (40001)', async () => {
    let attempts = 0;
    const pool = fakePool();
    const result = await withTxRetry(pool, async () => {
      attempts += 1;
      if (attempts < 2) throw new PgError('40001');
      return 'ok';
    }, { baseDelayMs: 0 });
    expect(attempts).toBe(2);
    expect(result).toBe('ok');
  });

  it('does not retry non-transient errors', async () => {
    let attempts = 0;
    const pool = fakePool();
    await expect(withTxRetry(pool, async () => {
      attempts += 1;
      throw new PgError('23505'); // unique violation
    }, { baseDelayMs: 0 })).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    let attempts = 0;
    const pool = fakePool();
    await expect(withTxRetry(pool, async () => {
      attempts += 1;
      throw new PgError('40P01');
    }, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toMatchObject({ code: '40P01' });
    expect(attempts).toBe(3);
  });
});
