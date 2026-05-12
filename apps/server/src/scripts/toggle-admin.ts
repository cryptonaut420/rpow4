/**
 * Toggle admin publishing privileges for an account (ops).
 * One argument: base58 pubkey OR registered handle (case-insensitive).
 *
 *   DATABASE_URL=postgres://... npm --workspace @rpow/server run toggle-admin -- alice
 */

import pg from 'pg';
import { isValidPubkeyBase58 } from '@rpow/shared';

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

type Row = {
  pubkey: string;
  is_admin: boolean;
  display_name: string | null;
};

async function resolveAccount(pool: pg.Pool, raw: string): Promise<Row | null> {
  const q = raw.trim();
  if (!q) return null;

  if (isValidPubkeyBase58(q)) {
    const r = await pool.query<Row>(
      `SELECT pubkey, is_admin, display_name FROM accounts WHERE pubkey = $1`,
      [q],
    );
    return r.rows[0] ?? null;
  }

  const r = await pool.query<Row>(
    `SELECT pubkey, is_admin, display_name FROM accounts
     WHERE lower(display_name) = lower($1)`,
    [q],
  );
  return r.rows[0] ?? null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) die('DATABASE_URL is required');

  const argv = process.argv.slice(2);
  if (argv.length !== 1) die('usage: toggle-admin <pubkey | handle>\n  DATABASE_URL must be set.');
  const arg = argv[0]!;

  const pool = new pg.Pool({ connectionString: url });
  try {
    const row = await resolveAccount(pool, arg);
    if (!row) {
      die(
        isValidPubkeyBase58(arg)
          ? `no account for pubkey ${arg}`
          : `no account with handle "${arg}"`,
        2,
      );
    }

    const next = !row.is_admin;
    await pool.query(`UPDATE accounts SET is_admin = $2 WHERE pubkey = $1`, [row.pubkey, next]);

    const label = row.display_name ? `"${row.display_name}" (${row.pubkey})` : row.pubkey;
    console.log(next ? `admin ENABLED for ${label}` : `admin DISABLED for ${label}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
