import { describe, it, expect } from 'vitest';
import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('returns the cached value within ttl', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 100 });
    let calls = 0;
    const a = await c.get('k', async () => { calls += 1; return 42; });
    const b = await c.get('k', async () => { calls += 1; return 99; });
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });

  it('reloads after ttl expiry', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 5 });
    let calls = 0;
    await c.get('k', async () => { calls += 1; return 1; });
    await new Promise((r) => setTimeout(r, 15));
    await c.get('k', async () => { calls += 1; return 2; });
    expect(calls).toBe(2);
  });

  it('single-flights concurrent loads for the same key', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    let calls = 0;
    const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return 7; };
    const results = await Promise.all([
      c.get('k', loader), c.get('k', loader), c.get('k', loader),
    ]);
    expect(results).toEqual([7, 7, 7]);
    expect(calls).toBe(1);
  });

  it('retries the loader after a previous failure', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    let calls = 0;
    await expect(c.get('k', async () => { calls += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    // First attempt failed and was not cached, so a second call re-runs the loader.
    await expect(c.get('k', async () => { calls += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('drops a single key on invalidate()', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    await c.get('a', async () => 1);
    await c.get('b', async () => 2);
    c.invalidate('a');
    let aCalls = 0;
    let bCalls = 0;
    await c.get('a', async () => { aCalls += 1; return 1; });
    await c.get('b', async () => { bCalls += 1; return 2; });
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(0);
  });

  it('does not cache an in-flight value after invalidate()', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    let resolve!: (value: number) => void;
    const first = c.get('k', async () => new Promise<number>((r) => { resolve = r; }));
    c.invalidate('k');
    resolve(1);
    expect(await first).toBe(1);

    let calls = 0;
    const second = await c.get('k', async () => { calls += 1; return 2; });
    expect(second).toBe(2);
    expect(calls).toBe(1);
  });

  it('does not cache an in-flight value after clear()', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    let resolve!: (value: number) => void;
    const first = c.get('k', async () => new Promise<number>((r) => { resolve = r; }));
    c.clear();
    resolve(1);
    expect(await first).toBe(1);

    let calls = 0;
    const second = await c.get('k', async () => { calls += 1; return 2; });
    expect(second).toBe(2);
    expect(calls).toBe(1);
  });

  it('does not let an invalidated loader clear a newer in-flight loader', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000 });
    let resolveFirst!: (value: number) => void;
    let resolveSecond!: (value: number) => void;

    const first = c.get('k', async () => new Promise<number>((r) => { resolveFirst = r; }));
    c.invalidate('k');
    const second = c.get('k', async () => new Promise<number>((r) => { resolveSecond = r; }));

    resolveFirst(1);
    expect(await first).toBe(1);

    // The first loader's finally must not delete the second in-flight
    // promise, otherwise this third call would start a duplicate load.
    const third = c.get('k', async () => 3);
    resolveSecond(2);
    expect(await second).toBe(2);
    expect(await third).toBe(2);
  });

  it('evicts the least-recently-used entry past maxSize', async () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000, maxSize: 2 });
    await c.get('a', async () => 1);
    await c.get('b', async () => 2);
    // Touch 'a' so 'b' becomes the LRU.
    await c.get('a', async () => -1);
    await c.get('c', async () => 3);
    expect(c.peek('a')).toBe(1);
    expect(c.peek('b')).toBeUndefined();
    expect(c.peek('c')).toBe(3);
  });
});
