import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, runMigrations } from '../src/db.js';

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

  it('is idempotent', async () => {
    await runMigrations(pool); // run again, no error
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations');
    expect(rowCount).toBeGreaterThan(0);
  });
});
