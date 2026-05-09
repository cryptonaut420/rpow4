import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PoolOptions {
  max?: number;
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export function createPool(databaseUrl: string, opts: PoolOptions = {}): Pool {
  // Postgres default max_connections is 100; 30 leaves plenty of headroom
  // for backups (pg_dump uses 1) and the postgres role's own sessions.
  // 10 was bottlenecking under thousands of concurrent users.
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 30,
    statement_timeout: opts.statementTimeoutMs ?? 5_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 2_000,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
  });
  // Without a listener, an idle-client error crashes the process. The
  // server.ts entrypoint can replace this default with structured
  // logging via attachPoolErrorLogger().
  pool.on('error', () => { /* swallowed by default; see attachPoolErrorLogger */ });
  return pool;
}

/**
 * Attach a structured logger to pool client errors. Idle clients that
 * hit a network blip emit `'error'` events on the pool itself (not the
 * caller's query promise), so this is the only place to observe them.
 */
export function attachPoolErrorLogger(pool: Pool, log: (msg: string, err: unknown) => void): void {
  pool.removeAllListeners('error');
  pool.on('error', (err) => {
    log('pg pool client error', err);
  });
}

/** Cheap readiness probe used by /health/ready. */
export async function pingPool(pool: Pool): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query({ text: 'SELECT 1', rowMode: 'array' });
    return true;
  } catch {
    return false;
  } finally {
    try { c.release(); } catch { /* ignore */ }
  }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw e;
  } finally { c.release(); }
}

/**
 * Postgres SQLSTATEs we treat as transient and retry-safe.
 *
 *   40001  serialization_failure  — concurrent updates on the same row
 *   40P01  deadlock_detected      — cycle in the lock graph
 *
 * Both are guaranteed to have rolled back, so retrying the closure is
 * safe and idempotent at the database layer. Higher-level idempotency
 * (e.g. unique idempotency_key on transfers) handles the case where the
 * application already observed a partial success on a prior attempt.
 */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export interface RetryOptions {
  maxAttempts?: number;
  /** Initial backoff in ms; doubles each retry. */
  baseDelayMs?: number;
  /** Optional logger called on each retry. */
  onRetry?: (err: unknown, attempt: number) => void;
}

export async function withTxRetry<T>(
  pool: Pool,
  fn: (c: PoolClient) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 5;
  let attempt = 0;
  for (;;) {
    try {
      return await withTx(pool, fn);
    } catch (e: any) {
      attempt += 1;
      const code = e?.code;
      if (attempt >= maxAttempts || !RETRYABLE_PG_CODES.has(code)) throw e;
      opts.onRetry?.(e, attempt);
      // Exponential backoff with full jitter, capped at 200ms.
      const delay = Math.min(200, baseDelayMs * 2 ** (attempt - 1)) * Math.random();
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
    if (rows.length) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    await withTx(pool, async (c) => {
      await c.query('SET LOCAL statement_timeout = 0');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    });
  }
}
