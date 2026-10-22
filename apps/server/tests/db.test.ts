import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, runMigrations } from '../src/db.js';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
const skip = !url;

describe.skipIf(skip)('db migrations', () => {
  const pool = createPool(url!);
  beforeAll(async () => { await runMigrations(pool); });
  afterAll(async () => { await pool.end(); });

  it('creates tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'accounts',
      'account_balances',
      'app_counters',
      'ledger_events',
      'ledger_event_ids',
      'ledger_mint_claims',
      'ledger_recent_events',
      'ledger_transfer_idempotency',
      'account_recent_events',
      'ledger_stats',
      'ledger_stat_shards',
      'schema_migrations',
    ]) {
      expect(names).toContain(t);
    }
    // Email-era tables removed in 011, transactional pre-013 tables
    // removed in 014.
    for (const t of [
      'users', 'magic_links', 'pending_transfers', 'srpow_wrap_events',
      'tokens', 'transfers', 'challenges',
    ]) {
      expect(names).not.toContain(t);
    }
  });

  it('partitions the durable ledger for billion-row history', async () => {
    const { rows: ledger } = await pool.query(
      `SELECT relkind FROM pg_class WHERE relname='ledger_events'`,
    );
    expect(ledger[0]?.relkind).toBe('p');

    const { rows: partitions } = await pool.query(
      `SELECT count(*)::int AS n
       FROM pg_inherits
       WHERE inhparent = 'ledger_events'::regclass`,
    );
    // 128 range partitions + default safety partition.
    expect(partitions[0].n).toBeGreaterThanOrEqual(129);
  });

  it('ignores legacy tables in other schemas when migrating a fresh schema', async () => {
    const suffix = randomBytes(4).toString('hex');
    const legacy = `legacy_${suffix}`;
    const fresh = `fresh_${suffix}`;
    await pool.query(`CREATE SCHEMA ${legacy}; CREATE SCHEMA ${fresh}`);
    await pool.query(`CREATE TABLE ${legacy}.tokens (value BIGINT); CREATE TABLE ${legacy}.transfers (amount BIGINT)`);
    const isolated = new pg.Pool({ connectionString: url!, options: `-c search_path=${fresh}` });
    try {
      await runMigrations(isolated);
      const applied = await isolated.query('SELECT filename FROM schema_migrations WHERE filename=$1', ['034_bigint_to_numeric.sql']);
      expect(applied.rowCount).toBe(1);
      const untouched = await pool.query(
        'SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',
        [legacy, 'tokens', 'value'],
      );
      expect(untouched.rows[0].data_type).toBe('bigint');
    } finally {
      await isolated.end();
      await pool.query(`DROP SCHEMA ${fresh} CASCADE; DROP SCHEMA ${legacy} CASCADE`);
    }
  });

  it('is idempotent', async () => {
    await runMigrations(pool); // run again, no error
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations');
    expect(rowCount).toBeGreaterThan(0);
  });
});
