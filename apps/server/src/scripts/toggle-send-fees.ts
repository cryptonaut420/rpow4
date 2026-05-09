/**
 * Toggle per-send fee waiver for an account (ops).
 * One argument: base58 pubkey OR registered handle (case-insensitive).
 * Flips send_fees_waived: if currently off → on; if on → off.
 *
 *   DATABASE_URL=postgres://… npm run toggle-send-fees -- alice
 *   DATABASE_URL=postgres://… npm run toggle-send-fees -- 9aXt…
 *
 * From repo root:
 *   DATABASE_URL=… npm --workspace @rpow/server run toggle-send-fees -- alice
 */

import pg from 'pg';
import { isValidPubkeyBase58 } from '@rpow/shared';

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

type Row = {
  pubkey: string;
  send_fees_waived: boolean;
  display_name: string | null;
};

async function resolveAccount(pool: pg.Pool, raw: string): Promise<Row | null> {
  const q = raw.trim();
  if (!q) return null;

  if (isValidPubkeyBase58(q)) {
    const r = await pool.query<Row>(
      `SELECT pubkey, send_fees_waived, display_name FROM accounts WHERE pubkey = $1`,
      [q],
    );
    return r.rows[0] ?? null;
  }

  const r = await pool.query<Row>(
    `SELECT pubkey, send_fees_waived, display_name FROM accounts
     WHERE lower(display_name) = lower($1)`,
    [q],
  );
  return r.rows[0] ?? null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) die('DATABASE_URL is required');

  const argv = process.argv.slice(2);
  if (argv.length !== 1) die('usage: toggle-send-fees <pubkey | handle>\n  DATABASE_URL must be set.');
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

    const next = !row.send_fees_waived;
    await pool.query(`UPDATE accounts SET send_fees_waived = $2 WHERE pubkey = $1`, [
      row.pubkey,
      next,
    ]);

    const label = row.display_name ? `"${row.display_name}" (${row.pubkey})` : row.pubkey;
    console.log(
      next
        ? `send fees WAIVED for ${label}`
        : `send fees RESTORED (normal fees) for ${label}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
