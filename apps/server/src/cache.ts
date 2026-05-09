import { createHash } from 'node:crypto';

/**
 * In-process TTL cache with single-flight loading and bounded LRU
 * eviction. Used to absorb read pressure on hot endpoints without a
 * 3rd-party dependency (no Redis, no memcached).
 *
 * Three properties matter:
 *
 *   1. TTL    — every entry expires after `ttlMs` so stale-after-write
 *               windows are bounded even if explicit invalidation is
 *               missed.
 *   2. Single-flight — concurrent `get(key, loader)` calls for the same
 *               key share a single in-flight loader promise. Stops
 *               thundering-herd refresh against the database.
 *   3. LRU bound — the cache never grows past `maxSize` keys (LRU
 *               eviction). Important for per-pubkey or per-name caches
 *               where the keyspace is unbounded.
 *
 * The cache is intentionally process-local. Multi-instance staleness is
 * bounded by `ttlMs` (kept small for write-sensitive endpoints).
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Time-to-live for each entry, in milliseconds. */
  ttlMs: number;
  /** Maximum number of keys retained; LRU evicted when exceeded. */
  maxSize?: number;
}

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  // Map preserves insertion order; we re-insert on access to maintain LRU.
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();
  // Bumped on invalidation/clear. Prevents stale in-flight loaders from
  // repopulating the cache after a write invalidated their result.
  private generation = 0;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize ?? 10_000;
  }

  /**
   * Return the cached value if fresh, otherwise call `loader()` once
   * (single-flight) and cache the result.
   */
  async get(key: K, loader: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const generationAtStart = this.generation;
    let promise!: Promise<V>;
    promise = (async () => {
      try {
        const value = await loader();
        if (generationAtStart === this.generation) {
          this.set(key, value);
        }
        return value;
      } finally {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Synchronously read a fresh entry, or undefined. */
  peek(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** Insert or replace an entry, evicting the oldest if over capacity. */
  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop a single key (e.g. on write). */
  invalidate(key: K): void {
    this.generation += 1;
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }

  /** Test/diagnostics helper. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Pre-serialized HTTP response cached entry. The body's JSON encoding
 * and ETag are computed once at insert time so each cache hit just
 * memcpys the existing string into the socket — zero re-stringify, zero
 * re-hash.
 *
 * For public, hot-path endpoints (/ledger, /ledger/stats, /ledger/events)
 * this turns the response path from "fetch -> JSON.stringify -> hash ->
 * write" into "memcpy -> write".
 */
export interface CachedJsonResponse {
  json: string;
  etag: string;
}

export function buildCachedJsonResponse(body: unknown): CachedJsonResponse {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(json).digest('base64url')}"`;
  return { json, etag };
}

