import { z } from 'zod';

/**
 * Coerce a positive integer-bigint env var into a `bigint`. We can't
 * lean on `z.coerce.bigint()` because it accepts arbitrary precision /
 * negative input; we want to mirror the behavior of the integer envs
 * (positive, finite) but in BigInt form so the schedule's base-units
 * arithmetic stays in `bigint` end-to-end.
 */
const positiveBigInt = (defaultValue: bigint) =>
  z
    .union([z.string(), z.bigint(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      const s = typeof v === 'string' ? v.trim() : v.toString();
      if (!/^[1-9][0-9]*$/.test(s)) {
        throw new Error('must be a positive integer string');
      }
      return BigInt(s);
    });

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(30),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SESSION_SECRET: z.string().min(32),
  RPOW_SIGNING_PRIVATE_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  RPOW_SIGNING_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),

  // Initial trailing-zero-bit difficulty. The schedule starts here at
  // block 0 and steps up by +1 every DIFFICULTY_STEP_BLOCKS blocks,
  // capped at DIFFICULTY_MAX_BITS. Production default is 24 (~10s on a
  // modern laptop), dev/local override to 14 for instant feedback.
  DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(24),
  DIFFICULTY_STEP_BLOCKS: z.coerce.number().int().positive().default(50_000),
  DIFFICULTY_MAX_BITS: z.coerce.number().int().min(4).max(64).default(50),

  // Anti-spam PoW for /signup. Tuned so a modern laptop completes in
  // well under a second (~262k hashes at 18 bits). Lower than the main
  // mining difficulty by design — this is friction, not currency. Crank
  // it up if abuse appears.
  SIGNUP_DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(18),

  // Block-based issuance schedule. Defaults match Bitcoin's exact math:
  // 50 RPOW initial reward × 210,000 blocks × 2 (geometric sum) =
  // 21,000,000 RPOW exactly.
  MINT_BASE_REWARD_BASE_UNITS: positiveBigInt(50_000_000_000n),
  HALVING_INTERVAL_BLOCKS: z.coerce.number().int().positive().default(210_000),
  MINT_MAX_SUPPLY: z.coerce.number().int().positive().default(21_000_000),

  // Per-send fee charged to the sender on top of the transfer amount.
  // Credited to the treasury account. Halves at every reward halving.
  // Default: 1 RPOW (1_000_000_000 base units). Set to 0 to disable.
  SEND_BASE_FEE_BASE_UNITS: z
    .union([z.string(), z.bigint(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return 1_000_000_000n;
      const s = typeof v === 'string' ? v.trim() : v.toString();
      if (!/^[0-9]+$/.test(s)) throw new Error('must be a non-negative integer string');
      return BigInt(s);
    }),

  // Public faucet. Grants free tokens from the treasury once per
  // FAUCET_COOLDOWN_HOURS window per (pubkey, IP). Set FAUCET_ENABLED=false
  // to take the route offline without a redeploy.
  FAUCET_ENABLED: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return true;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s !== 'false' && s !== '0' && s !== 'no';
    }),
  FAUCET_CLAIM_AMOUNT_BASE_UNITS: positiveBigInt(5_000_000_000n), // 5 RPOW
  FAUCET_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // Trollbox post fee, paid by the author to the treasury. Flat for now —
  // tunable via env so we can dial it up/down without a redeploy.
  TROLLBOX_POST_FEE_BASE_UNITS: positiveBigInt(5_000_000_000n), // 5 RPOW

  // Pooled mining: a single global pool that splits each block reward
  // across active participants by share contribution. Set
  // POOL_ENABLED=false to disable the entire pool subsystem (route
  // returns 503; UI clamps to solo-only).
  POOL_ENABLED: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return true;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s !== 'false' && s !== '0' && s !== 'no';
    }),
  // Treasury fee: bps off the gross block reward before any miner payouts.
  // 200 = 2%.
  POOL_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(200),
  // Finder bonus: bps of the post-fee reward that goes to the miner whose
  // share cleared network difficulty. The remaining (10000 - POOL_FINDER_BPS)
  // bps are split pro-rata among NON-finder shares. 2500 = 25%.
  POOL_FINDER_BPS: z.coerce.number().int().min(0).max(10000).default(2500),
  // Share difficulty = network_difficulty - POOL_SHARE_BITS_OFFSET, floored
  // at POOL_SHARE_MIN_BITS. A larger offset means more frequent shares per
  // miner (finer contribution measurement, more server load); smaller means
  // coarser. 10 bits ≈ ~1024 expected shares per network block.
  POOL_SHARE_BITS_OFFSET: z.coerce.number().int().min(2).max(20).default(10),
  // Floor on pool share difficulty. At network=24 / offset=10 the unclamped
  // share target would be 14 bits, which on a 5MH/s browser produces ~76
  // shares/sec/miner — a flood the server doesn't need. 20 bits keeps the
  // worst-case rate near 5 shares/sec/miner; production at network=32
  // with offset=10 lands above the floor naturally.
  POOL_SHARE_MIN_BITS: z.coerce.number().int().min(8).max(40).default(20),
  // Pool challenge lifetime. Worker auto-renews ~30s before expiry.
  POOL_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),

  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return false;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    }),
  TURNSTILE_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`invalid env: ${msg}`);
  }
  return parsed.data;
}
