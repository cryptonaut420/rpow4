import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(30),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SESSION_SECRET: z.string().min(32),
  RPOW_SIGNING_PRIVATE_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  RPOW_SIGNING_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(28),
  DIFFICULTY_FLOOR: z.coerce.number().int().min(4).max(40).default(20),
  // Anti-spam PoW for /signup. Tuned so a modern laptop completes in
  // 5–10s. Lower than the main mining difficulty by design — this is
  // friction, not currency. Easy to crank up if abuse appears.
  SIGNUP_DIFFICULTY_BITS: z.coerce.number().int().min(8).max(40).default(22),
  MINT_MAX_SUPPLY: z.coerce.number().int().positive().default(21_000_000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
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
