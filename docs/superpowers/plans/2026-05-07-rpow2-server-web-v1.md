# RPOW2 — Server + Web v1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship rpow4.com end-to-end as a working web product: Fastify+Postgres server + React+Vite web client. Magic-link login, hashcash mining (~30 s on a modern MacBook), server-issued Ed25519-signed RPOW tokens, email-keyed transfers that fail fast on unknown recipients, public ledger.

**Architecture:** npm workspaces monorepo with `apps/server`, `apps/web`, `packages/shared`. Server is a single Fastify process talking to Neon Postgres, signing tokens with Ed25519, sending magic-links via Resend. Web is a Vite+React SPA with a retro terminal UI; mining runs in a Web Worker with WASM SHA-256.

**Tech Stack:** TypeScript 5, Node 22, Fastify 4, Postgres (Neon), Resend, Vite 5, React 18, Web Workers + WASM SHA-256 (`hash-wasm`), Vitest, Playwright, Fly.io, Cloudflare Pages.

**Scope note:** Mobile app (Expo + native miner + Expo Push) is intentionally a separate follow-up plan that depends on this one being deployed and reachable at rpow4.com.

---

## Phase 0 — Repo bootstrap

### Task 0.1: Workspace skeleton

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "rpow",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "build": "tsc -b apps/server packages/shared && npm --workspace apps/web run build",
    "test": "npm --workspace packages/shared test && npm --workspace apps/server test && npm --workspace apps/web test",
    "lint": "tsc -b --noEmit && eslint .",
    "dev:server": "npm --workspace apps/server run dev",
    "dev:web": "npm --workspace apps/web run dev"
  },
  "engines": { "node": ">=22.0.0" },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
dist/
build/
.next/
.cache/
.env
.env.local
*.log
.DS_Store
.fly/
.wrangler/
.vite/
coverage/
playwright-report/
test-results/
```

- [ ] **Step 3: Create .nvmrc**

```
22.20.0
```

- [ ] **Step 4: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "lib": ["ES2022"],
    "types": ["node"],
    "declaration": true,
    "composite": true,
    "incremental": true
  }
}
```

- [ ] **Step 5: Create .editorconfig**

```
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
charset = utf-8
```

- [ ] **Step 6: Install root devDeps + commit**

```bash
cd /Users/fredkrueger/rpow
npm install
git add .
git commit -m "chore: workspace skeleton + tsconfig"
```

Expected: `package-lock.json` created; `node_modules` ignored.

---

## Phase 1 — Shared package

The shared package holds protocol types and difficulty math. Both server and web import from it.

### Task 1.1: packages/shared scaffold

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/protocol.ts`
- Create: `packages/shared/vitest.config.ts`

- [ ] **Step 1: Create packages/shared/package.json**

```json
{
  "name": "@rpow/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": { "vitest": "^1.6.0" }
}
```

- [ ] **Step 2: Create packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create packages/shared/vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 4: Create packages/shared/src/protocol.ts**

```ts
// Wire-format types used by both server and web.

export interface AuthRequestBody { email: string; turnstile_token?: string }
export interface AuthRequestResponse { ok: true; cooldown_seconds: number }

export interface MeResponse {
  email: string;
  balance: number;
  minted: number;
  sent: number;
  received: number;
}

export interface ChallengeResponse {
  challenge_id: string;
  nonce_prefix: string; // hex
  difficulty_bits: number;
  expires_at: string;   // iso8601
}

export interface MintRequestBody {
  challenge_id: string;
  solution_nonce: string; // decimal string of u64
}
export interface MintResponse { token: TokenSummary }

export interface TokenSummary {
  id: string;
  value: number;
  issued_at: string;
}

export interface SendRequestBody {
  recipient_email: string;
  amount: number;
  idempotency_key: string;
}
export interface SendResponse {
  ok: true;
  transferred: number;
  recipient_email: string;
  transfer_id: string;
}

export type ApiErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_SOLUTION'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CLAIMED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

export interface ActivityEntry {
  type: 'mint' | 'send' | 'receive';
  amount: number;
  counterparty_email?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface LedgerResponse {
  total_minted: number;
  total_transferred: number;
  circulating_supply: number;
  current_difficulty_bits: number;
  user_count: number;
}
```

- [ ] **Step 5: Create packages/shared/src/index.ts**

```ts
export * from './protocol.js';
export * from './difficulty.js';
```

- [ ] **Step 6: Install + build to verify**

```bash
npm install --workspace @rpow/shared
npm --workspace @rpow/shared run build
```

Expected: `packages/shared/dist/protocol.js` and `dist/protocol.d.ts` exist. Build will fail on missing `difficulty.js` import — that's fixed in the next task.

### Task 1.2: Trailing-zero-bit utility (TDD)

**Files:**
- Create: `packages/shared/src/difficulty.ts`
- Create: `packages/shared/src/difficulty.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/difficulty.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trailingZeroBits, hasEnoughTrailingZeros } from './difficulty.js';

describe('trailingZeroBits', () => {
  it('counts zero across all-zero bytes', () => {
    expect(trailingZeroBits(new Uint8Array([0]))).toBe(8);
  });
  it('returns 0 when last byte ends in 1 bit', () => {
    expect(trailingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(trailingZeroBits(new Uint8Array([0x01]))).toBe(0);
  });
  it('counts trailing zero bits inside a single byte', () => {
    // 0xf0 = 1111_0000 → 4 trailing zeros
    expect(trailingZeroBits(new Uint8Array([0xf0]))).toBe(4);
  });
  it('counts across multiple zero bytes', () => {
    // last byte 0x00, prev 0x10 (00010000) → 8 + 4 = 12
    expect(trailingZeroBits(new Uint8Array([0x10, 0x00]))).toBe(12);
  });
  it('caps at total bit length', () => {
    expect(trailingZeroBits(new Uint8Array([0, 0, 0]))).toBe(24);
  });
});

describe('hasEnoughTrailingZeros', () => {
  it('returns true at threshold', () => {
    expect(hasEnoughTrailingZeros(new Uint8Array([0xf0]), 4)).toBe(true);
  });
  it('returns false below threshold', () => {
    expect(hasEnoughTrailingZeros(new Uint8Array([0xf0]), 5)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm fails**

```bash
npm --workspace @rpow/shared test
```

Expected: error like "Cannot find module './difficulty.js'".

- [ ] **Step 3: Implement difficulty.ts**

`packages/shared/src/difficulty.ts`:

```ts
export function trailingZeroBits(buf: Uint8Array): number {
  let count = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i]!;
    if (b === 0) { count += 8; continue; }
    let bit = 0;
    while ((b & (1 << bit)) === 0) bit++;
    return count + bit;
  }
  return count;
}

export function hasEnoughTrailingZeros(buf: Uint8Array, target: number): boolean {
  return trailingZeroBits(buf) >= target;
}

export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** u64 little-endian from a JS number (for solution_nonce up to 2^53). */
export function u64leFromNumber(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt(n);
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
```

- [ ] **Step 4: Run, confirm passes**

```bash
npm --workspace @rpow/shared test
```

Expected: 5 passed in `difficulty.test.ts`.

- [ ] **Step 5: Build + commit**

```bash
npm --workspace @rpow/shared run build
git add packages/shared
git commit -m "feat(shared): protocol types + trailing-zero-bit math"
```

---

## Phase 2 — Server foundation

### Task 2.1: Server scaffold with /health (TDD)

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/server.ts`
- Create: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/health.test.ts`
- Create: `apps/server/vitest.config.ts`

- [ ] **Step 1: Create apps/server/package.json**

```json
{
  "name": "@rpow/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cookie": "^9.3.1",
    "@fastify/cors": "^9.0.1",
    "@fastify/rate-limit": "^9.1.0",
    "fastify": "^4.27.0",
    "pg": "^8.11.5",
    "pino": "^9.1.0",
    "resend": "^3.2.0",
    "zod": "^3.23.0",
    "@rpow/shared": "*"
  },
  "devDependencies": {
    "@types/pg": "^8.11.6",
    "tsx": "^4.11.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create apps/server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../../packages/shared" }]
}
```

- [ ] **Step 3: Create apps/server/vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
  },
});
```

- [ ] **Step 4: Write the failing test**

`apps/server/tests/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/buildApp.js';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = await buildApp({ test: true });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 5: Install + run, confirm fails**

```bash
npm install --workspace @rpow/server
npm --workspace @rpow/server test
```

Expected: error "Cannot find module '../src/buildApp.js'".

- [ ] **Step 6: Implement buildApp.ts**

`apps/server/src/buildApp.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions { test?: boolean }

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}
```

- [ ] **Step 7: Implement server.ts entry**

`apps/server/src/server.ts`:

```ts
import { buildApp } from './buildApp.js';

const port = Number(process.env.PORT ?? 8080);

const app = await buildApp();
await app.listen({ host: '0.0.0.0', port });
app.log.info(`rpow2 server listening on :${port}`);
```

- [ ] **Step 8: Run, confirm passes**

```bash
npm --workspace @rpow/server test
```

Expected: 1 passed.

- [ ] **Step 9: Commit**

```bash
git add apps/server
git commit -m "feat(server): fastify scaffold + /health"
```

### Task 2.2: Env config (zod-validated)

**Files:**
- Create: `apps/server/src/env.ts`
- Create: `apps/server/tests/env.test.ts`
- Create: `apps/server/.env.example`

- [ ] **Step 1: Write the failing test**

`apps/server/tests/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env.js';

describe('parseEnv', () => {
  it('parses a valid env', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow4.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      DIFFICULTY_BITS: '8',
    });
    expect(env.DIFFICULTY_BITS).toBe(8);
  });
  it('rejects when DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run, confirm fails**

```bash
npm --workspace @rpow/server test -- env.test.ts
```

Expected: "Cannot find module '../src/env.js'".

- [ ] **Step 3: Implement env.ts**

`apps/server/src/env.ts`:

```ts
import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email().or(z.string().regex(/^[^@<>]+<[^@<>]+@[^@<>]+>$/)),
  SESSION_SECRET: z.string().min(32),
  MAGIC_LINK_BASE_URL: z.string().url(),
  RPOW_SIGNING_PRIVATE_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  RPOW_SIGNING_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(28),
  DIFFICULTY_FLOOR: z.coerce.number().int().min(4).max(40).default(20),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  TURNSTILE_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`invalid env: ${msg}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Create .env.example**

`apps/server/.env.example`:

```
NODE_ENV=development
PORT=8080
DATABASE_URL=postgres://localhost:5432/rpow_dev
RESEND_API_KEY=re_xxx
EMAIL_FROM="rpow4 <no-reply@rpow4.com>"
SESSION_SECRET=replace-with-32-plus-bytes-of-randomness
MAGIC_LINK_BASE_URL=http://localhost:8080
RPOW_SIGNING_PRIVATE_KEY_HEX=...
RPOW_SIGNING_PUBLIC_KEY_HEX=...
DIFFICULTY_BITS=28
DIFFICULTY_FLOOR=20
WEB_ORIGIN=http://localhost:5173
TURNSTILE_SECRET=
```

- [ ] **Step 5: Run, confirm passes; commit**

```bash
npm --workspace @rpow/server test
git add apps/server/src/env.ts apps/server/tests/env.test.ts apps/server/.env.example
git commit -m "feat(server): zod-validated env config"
```

### Task 2.3: Postgres pool + migration runner

**Files:**
- Create: `apps/server/src/db.ts`
- Create: `apps/server/migrations/001_init.sql`
- Create: `apps/server/tests/db.test.ts`

- [ ] **Step 1: Create the initial migration**

`apps/server/migrations/001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS magic_links (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);

CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  nonce_prefix BYTEA NOT NULL,
  difficulty_bits INT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS challenges_user_idx ON challenges(user_email);

CREATE TABLE IF NOT EXISTS tokens (
  id UUID PRIMARY KEY,
  owner_email TEXT NOT NULL,
  value INT NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('VALID','INVALIDATED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at TIMESTAMPTZ,
  parent_token_id UUID REFERENCES tokens(id),
  server_sig BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_owner_state_idx ON tokens(owner_email, state);

CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Implement db.ts**

`apps/server/src/db.ts`:

```ts
import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
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
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    });
  }
}
```

- [ ] **Step 3: Write integration test (requires local Postgres)**

`apps/server/tests/db.test.ts`:

```ts
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
    const names = rows.map(r => r.table_name);
    for (const t of ['users', 'magic_links', 'challenges', 'tokens', 'transfers', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', async () => {
    await runMigrations(pool); // run again, no error
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations');
    expect(rowCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run with a local Postgres**

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16
sleep 3
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test -- db.test.ts
docker stop rpow-pg
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): postgres pool + migration runner + initial schema"
```

### Task 2.4: Wire DB + migrations into buildApp

**Files:**
- Modify: `apps/server/src/buildApp.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Update buildApp to accept a Pool**

`apps/server/src/buildApp.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface BuildAppOptions { test?: boolean; pool?: Pool }

declare module 'fastify' {
  interface FastifyInstance { pool: Pool }
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
  });

  if (opts.pool) app.decorate('pool', opts.pool);

  app.get('/health', async () => ({ ok: true }));

  return app;
}
```

- [ ] **Step 2: Update server.ts to load env, create pool, run migrations**

`apps/server/src/server.ts`:

```ts
import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

const app = await buildApp({ pool });
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow2 server listening on :${env.PORT}`);
```

- [ ] **Step 3: Verify health test still passes; commit**

```bash
npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): wire db pool + migrations into entrypoint"
```

---

## Phase 3 — Magic-link auth

### Task 3.1: Mailer interface + Resend implementation

**Files:**
- Create: `apps/server/src/mailer.ts`
- Create: `apps/server/tests/mailer.test.ts`

- [ ] **Step 1: Test the in-memory fake mailer behavior**

`apps/server/tests/mailer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeMailer } from '../src/mailer.js';

describe('FakeMailer', () => {
  it('captures sent messages for inspection', async () => {
    const m = new FakeMailer();
    await m.send({ to: 'a@b.com', subject: 's', html: '<a href="x">x</a>', text: 'x' });
    expect(m.outbox).toHaveLength(1);
    expect(m.outbox[0]!.to).toBe('a@b.com');
    expect(m.lastTo('a@b.com')!.html).toContain('href="x"');
  });
});
```

- [ ] **Step 2: Implement mailer.ts**

`apps/server/src/mailer.ts`:

```ts
import { Resend } from 'resend';

export interface SendArgs { to: string; subject: string; html: string; text: string }
export interface Mailer { send(args: SendArgs): Promise<void> }

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}
  async send(a: SendArgs): Promise<void> {
    const c = new Resend(this.apiKey);
    const { error } = await c.emails.send({
      from: this.from, to: a.to, subject: a.subject, html: a.html, text: a.text,
    });
    if (error) throw new Error(`resend: ${error.message}`);
  }
}

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
```

- [ ] **Step 3: Run + commit**

```bash
npm --workspace @rpow/server test -- mailer.test.ts
git add apps/server/src/mailer.ts apps/server/tests/mailer.test.ts
git commit -m "feat(server): mailer interface + Resend impl + fake"
```

### Task 3.2: Magic-link issue + verify primitives (TDD)

**Files:**
- Create: `apps/server/src/magic.ts`
- Create: `apps/server/tests/magic.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/magic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { issueMagicLink, verifyMagicLink, hashToken } from '../src/magic.js';

describe('magic-link primitives', () => {
  it('issued token verifies', () => {
    const { token, hash } = issueMagicLink();
    expect(hashToken(token).equals(hash)).toBe(true);
  });
  it('verifyMagicLink returns true on match', () => {
    const { token, hash } = issueMagicLink();
    expect(verifyMagicLink(token, hash)).toBe(true);
  });
  it('verifyMagicLink returns false on mismatch', () => {
    const { hash } = issueMagicLink();
    expect(verifyMagicLink('wrong', hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`apps/server/src/magic.ts`:

```ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url encoded. */
export function issueMagicLink(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  const token = raw.toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function verifyMagicLink(token: string, expectedHash: Buffer): boolean {
  const got = hashToken(token);
  return got.length === expectedHash.length && timingSafeEqual(got, expectedHash);
}
```

- [ ] **Step 3: Test, commit**

```bash
npm --workspace @rpow/server test -- magic.test.ts
git add apps/server/src/magic.ts apps/server/tests/magic.test.ts
git commit -m "feat(server): magic-link issue/verify primitives"
```

### Task 3.3: POST /auth/request route (integration test)

**Files:**
- Create: `apps/server/src/routes/auth.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/authRequest.test.ts`
- Create: `apps/server/tests/helpers.ts`

- [ ] **Step 1: Test helpers**

`apps/server/tests/helpers.ts`:

```ts
import { createPool, runMigrations } from '../src/db.js';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { FakeMailer } from '../src/mailer.js';
import { buildApp } from '../src/buildApp.js';

export async function makeTestApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  mailer: FakeMailer;
  cleanup: () => Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL required');
  const pool = createPool(url);
  const schema = `t_${randomBytes(4).toString('hex')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}`);
  await runMigrations(pool);
  const mailer = new FakeMailer();
  const app = await buildApp({
    pool,
    mailer,
    test: true,
    config: {
      sessionSecret: 'x'.repeat(32),
      magicLinkBaseUrl: 'http://test',
      difficultyBits: 8,
      difficultyFloor: 4,
      signingPrivateKeyHex: '11'.repeat(32),
      signingPublicKeyHex: '22'.repeat(32),
      webOrigin: 'http://web.test',
    },
  });
  return {
    app, pool, mailer,
    cleanup: async () => { await app.close(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); },
  };
}
```

- [ ] **Step 2: Test for /auth/request**

`apps/server/tests/authRequest.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('POST /auth/request', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('emails a magic link and stores a hashed token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/auth/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'frk314@gmail.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.mailer.outbox).toHaveLength(1);
    expect(ctx.mailer.outbox[0]!.to).toBe('frk314@gmail.com');
    expect(ctx.mailer.outbox[0]!.html).toMatch(/http:\/\/test\/auth\/verify\?token=/);
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM magic_links WHERE email=$1', ['frk314@gmail.com']);
    expect(rowCount).toBe(1);
  });

  it('rejects malformed email', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/auth/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Update buildApp signature for test config + mailer**

`apps/server/src/buildApp.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { Mailer } from './mailer.js';
import { authRoutes } from './routes/auth.js';

export interface AppConfig {
  sessionSecret: string;
  magicLinkBaseUrl: string;
  difficultyBits: number;
  difficultyFloor: number;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
}

export interface BuildAppOptions {
  test?: boolean;
  pool: Pool;
  mailer: Mailer;
  config: AppConfig;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    mailer: Mailer;
    config: AppConfig;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
  });

  app.decorate('pool', opts.pool);
  app.decorate('mailer', opts.mailer);
  app.decorate('config', opts.config);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(cors, {
    origin: opts.config.webOrigin,
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);

  return app;
}
```

- [ ] **Step 4: Implement routes/auth.ts (request only for now)**

`apps/server/src/routes/auth.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { issueMagicLink } from '../magic.js';

const RequestBody = z.object({ email: z.string().email() });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid email' });
    const email = parsed.data.email.toLowerCase().trim();

    const { token, hash } = issueMagicLink();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await app.pool.query(
      'INSERT INTO magic_links(id, email, token_hash, expires_at) VALUES($1,$2,$3,$4)',
      [id, email, hash, expiresAt],
    );

    const link = `${app.config.magicLinkBaseUrl}/auth/verify?token=${token}`;
    await app.mailer.send({
      to: email,
      subject: 'rpow2 — your magic link',
      text: `Click to sign in:\n${link}\n\nLink expires in 15 minutes.`,
      html: `<p>Click to sign in to <a href="${link}">rpow2</a>.</p><p><a href="${link}">${link}</a></p><p>Link expires in 15 minutes.</p>`,
    });

    return { ok: true, cooldown_seconds: 30 };
  });
}
```

- [ ] **Step 5: Run + commit**

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16
sleep 3
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
docker stop rpow-pg
git add apps/server
git commit -m "feat(server): POST /auth/request issues magic link via mailer"
```

### Task 3.4: GET /auth/verify + cookie session

**Files:**
- Create: `apps/server/src/session.ts`
- Create: `apps/server/tests/session.test.ts`
- Modify: `apps/server/src/routes/auth.ts`
- Create: `apps/server/tests/authVerify.test.ts`

- [ ] **Step 1: Test session sign/verify**

`apps/server/tests/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from '../src/session.js';

describe('session token', () => {
  const secret = 's'.repeat(32);
  it('signed token verifies and yields email', () => {
    const tok = signSession({ email: 'a@b.com' }, secret, 60);
    const claim = verifySession(tok, secret);
    expect(claim?.email).toBe('a@b.com');
  });
  it('expired tokens fail', () => {
    const tok = signSession({ email: 'a@b.com' }, secret, -1);
    expect(verifySession(tok, secret)).toBeNull();
  });
  it('tampered tokens fail', () => {
    const tok = signSession({ email: 'a@b.com' }, secret, 60);
    expect(verifySession(tok + 'x', secret)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement session.ts**

`apps/server/src/session.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaim { email: string; exp: number }

export function signSession(claim: { email: string }, secret: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ email: claim.email, exp })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionClaim | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaim;
    if (typeof c.email !== 'string' || typeof c.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) >= c.exp) return null;
    return c;
  } catch { return null; }
}

export const SESSION_COOKIE = 'rpow_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
```

- [ ] **Step 3: Test for /auth/verify**

`apps/server/tests/authVerify.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /auth/verify', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('exchanges valid token for session cookie + creates user', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email: 'frk@x.com' } });
    const link = ctx.mailer.outbox[0]!.text.match(/token=([\w-]+)/)![1];
    const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['set-cookie']).toMatch(/rpow_session=/);
    const { rows } = await ctx.pool.query('SELECT email FROM users');
    expect(rows[0]!.email).toBe('frk@x.com');
  });

  it('rejects an unknown token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/verify?token=nope' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a reused token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.com' } });
    const link = ctx.mailer.outbox[0]!.text.match(/token=([\w-]+)/)![1];
    await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    const res2 = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    expect(res2.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Extend routes/auth.ts**

`apps/server/src/routes/auth.ts` (replace whole file):

```ts
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { issueMagicLink, verifyMagicLink } from '../magic.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS, verifySession } from '../session.js';

const RequestBody = z.object({ email: z.string().email() });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid email' });
    const email = parsed.data.email.toLowerCase().trim();

    const { token, hash } = issueMagicLink();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await app.pool.query(
      'INSERT INTO magic_links(id, email, token_hash, expires_at) VALUES($1,$2,$3,$4)',
      [id, email, hash, expiresAt],
    );
    const link = `${app.config.magicLinkBaseUrl}/auth/verify?token=${token}`;
    await app.mailer.send({
      to: email,
      subject: 'rpow2 — your magic link',
      text: `Click to sign in:\n${link}\n\nLink expires in 15 minutes.`,
      html: `<p>Click to sign in to <a href="${link}">rpow2</a>.</p><p><a href="${link}">${link}</a></p><p>Link expires in 15 minutes.</p>`,
    });
    return { ok: true, cooldown_seconds: 30 };
  });

  app.get('/auth/verify', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });

    const { rows } = await app.pool.query(
      'SELECT id, email, token_hash, expires_at, used_at FROM magic_links WHERE expires_at > now() AND used_at IS NULL',
    );
    const match = rows.find(r => verifyMagicLink(token, r.token_hash));
    if (!match) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid or expired link' });

    await app.pool.query('UPDATE magic_links SET used_at=now() WHERE id=$1', [match.id]);

    await app.pool.query(
      `INSERT INTO users(email) VALUES($1)
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()`,
      [match.email],
    );

    const sessionToken = signSession({ email: match.email }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true, secure: !req.headers.host?.startsWith('localhost'),
      sameSite: 'lax', path: '/', maxAge: SESSION_TTL_SECONDS,
    });
    return reply.redirect(`${app.config.webOrigin}/#/wallet`, 302);
  });

  app.post('/auth/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

export function readSession(req: { cookies: Record<string, string | undefined> }, secret: string): { email: string } | null {
  const tok = req.cookies[SESSION_COOKIE];
  if (!tok) return null;
  return verifySession(tok, secret);
}
```

- [ ] **Step 5: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): GET /auth/verify exchanges link for session cookie"
```

### Task 3.5: Auth middleware + GET /me

**Files:**
- Create: `apps/server/src/routes/me.ts`
- Modify: `apps/server/src/buildApp.ts` (register `/me`)
- Create: `apps/server/tests/me.test.ts`

- [ ] **Step 1: Test /me**

`apps/server/tests/me.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return res.headers['set-cookie'] as string;
}

describe('GET /me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns email + zero balances on first login', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'a@b.com', balance: 0, minted: 0, sent: 0, received: 0 });
  });
});
```

- [ ] **Step 2: Implement routes/me.ts**

`apps/server/src/routes/me.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const [{ rows: bal }, { rows: minted }, { rows: sent }, { rows: recv }] = await Promise.all([
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND state='VALID'`, [email]),
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE sender_email=$1`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE recipient_email=$1`, [email]),
    ]);
    return {
      email,
      balance: bal[0]!.n,
      minted: minted[0]!.n,
      sent: sent[0]!.n,
      received: recv[0]!.n,
    };
  });
}
```

- [ ] **Step 3: Register in buildApp**

In `apps/server/src/buildApp.ts`, after `await app.register(authRoutes);`:

```ts
import { meRoutes } from './routes/me.js';
// ...
await app.register(meRoutes);
```

- [ ] **Step 4: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): GET /me with auth middleware"
```

### Task 3.6: Magic-link rate limits (30s cooldown / 30 per hour per email / 60 per hour per IP)

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Modify: `apps/server/migrations/001_init.sql` (already has magic_links; add an IP column via new migration)
- Create: `apps/server/migrations/002_magic_link_ip.sql`
- Create: `apps/server/tests/authRateLimit.test.ts`

- [ ] **Step 1: Add IP column migration**

`apps/server/migrations/002_magic_link_ip.sql`:

```sql
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS ip_addr INET;
CREATE INDEX IF NOT EXISTS magic_links_ip_idx ON magic_links(ip_addr, created_at);
CREATE INDEX IF NOT EXISTS magic_links_email_created_idx ON magic_links(email, created_at);
```

- [ ] **Step 2: Test cooldown + per-email + per-IP limits**

`apps/server/tests/authRateLimit.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('magic-link rate limiting', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('cools down a 2nd request to same email within 30s', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const ok = await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
    expect(ok.statusCode).toBe(200);
    const limited = await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.retry_after).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Update /auth/request with limits**

Replace the body of `/auth/request` in `apps/server/src/routes/auth.ts` with:

```ts
  app.post('/auth/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid email' });
    const email = parsed.data.email.toLowerCase().trim();
    const ip = (req.ip ?? '0.0.0.0');

    const cooldown = await app.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM magic_links WHERE email=$1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    if (cooldown.rows[0]) {
      const elapsedMs = Date.now() - cooldown.rows[0].created_at.getTime();
      if (elapsedMs < 30_000) {
        return reply.code(429).send({ error: 'RATE_LIMITED', message: 'try again shortly', retry_after: Math.ceil((30_000 - elapsedMs) / 1000) });
      }
    }

    const perEmail = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM magic_links WHERE email=$1 AND created_at > now() - interval '1 hour'`,
      [email],
    );
    if ((perEmail.rows[0]?.n ?? 0) >= 30) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'too many attempts on this email; try again later', retry_after: 60 * 30 });
    }

    const perIp = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM magic_links WHERE ip_addr=$1 AND created_at > now() - interval '1 hour'`,
      [ip],
    );
    if ((perIp.rows[0]?.n ?? 0) >= 60) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'too many attempts from this network', retry_after: 60 * 30 });
    }

    const { token, hash } = issueMagicLink();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await app.pool.query(
      'INSERT INTO magic_links(id, email, token_hash, expires_at, ip_addr) VALUES($1,$2,$3,$4,$5)',
      [id, email, hash, expiresAt, ip],
    );
    const link = `${app.config.magicLinkBaseUrl}/auth/verify?token=${token}`;
    await app.mailer.send({
      to: email,
      subject: 'rpow2 — your magic link',
      text: `Click to sign in:\n${link}\n\nLink expires in 15 minutes.`,
      html: `<p>Click to sign in to <a href="${link}">rpow2</a>.</p><p><a href="${link}">${link}</a></p><p>Link expires in 15 minutes.</p>`,
    });

    return { ok: true, cooldown_seconds: 30 };
  });
```

- [ ] **Step 4: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): magic-link rate limits (30s cooldown, 30/hr email, 60/hr IP)"
```

---

## Phase 4 — Mining

### Task 4.1: Ed25519 token signing (TDD)

**Files:**
- Create: `apps/server/src/signing.ts`
- Create: `apps/server/tests/signing.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/signing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateKeypair, signTokenPayload, verifyTokenPayload } from '../src/signing.js';

describe('Ed25519 token signing', () => {
  it('signs and verifies a payload', () => {
    const kp = generateKeypair();
    const payload = { id: 'tok-1', owner_email_hash: 'aaa', value: 1, issued_at: '2026-05-07T00:00:00Z' };
    const sig = signTokenPayload(payload, kp.privateHex);
    expect(verifyTokenPayload(payload, sig, kp.publicHex)).toBe(true);
  });
  it('rejects a tampered payload', () => {
    const kp = generateKeypair();
    const payload = { id: 'tok-1', owner_email_hash: 'aaa', value: 1, issued_at: '2026-05-07T00:00:00Z' };
    const sig = signTokenPayload(payload, kp.privateHex);
    expect(verifyTokenPayload({ ...payload, value: 2 }, sig, kp.publicHex)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`apps/server/src/signing.ts`:

```ts
import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';

export interface TokenPayload {
  id: string;
  owner_email_hash: string;
  value: number;
  issued_at: string;
}

export function generateKeypair(): { privateHex: string; publicHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Raw 32-byte keys (DER-stripped)
  const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateHex: privRaw.toString('hex'), publicHex: pubRaw.toString('hex') };
}

function privKeyFromHex(hex: string) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
function pubKeyFromHex(hex: string) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function canonical(payload: TokenPayload): Buffer {
  const ordered = JSON.stringify({
    id: payload.id, owner_email_hash: payload.owner_email_hash, value: payload.value, issued_at: payload.issued_at,
  });
  return Buffer.from(ordered, 'utf8');
}

export function signTokenPayload(payload: TokenPayload, privHex: string): Buffer {
  return sign(null, canonical(payload), privKeyFromHex(privHex));
}

export function verifyTokenPayload(payload: TokenPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonical(payload), pubKeyFromHex(pubHex), sig);
}
```

- [ ] **Step 3: Run + commit**

```bash
npm --workspace @rpow/server test -- signing.test.ts
git add apps/server/src/signing.ts apps/server/tests/signing.test.ts
git commit -m "feat(server): Ed25519 token signing"
```

### Task 4.2: PoW verifier (TDD)

**Files:**
- Create: `apps/server/src/pow.ts`
- Create: `apps/server/tests/pow.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/pow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { verifySolution, findSolutionForTest } from '../src/pow.js';

describe('verifySolution', () => {
  it('accepts a valid 8-bit-trailing-zero solution', () => {
    const prefix = Buffer.from('deadbeef', 'hex');
    const nonce = findSolutionForTest(prefix, 8);
    expect(verifySolution(prefix, nonce, 8)).toBe(true);
  });
  it('rejects an off-by-one prefix', () => {
    const prefix = Buffer.from('deadbeef', 'hex');
    const nonce = findSolutionForTest(prefix, 8);
    expect(verifySolution(Buffer.from('deadbef0', 'hex'), nonce, 8)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`apps/server/src/pow.ts`:

```ts
import { createHash } from 'node:crypto';
import { trailingZeroBits, u64leFromNumber } from '@rpow/shared';

export function verifySolution(noncePrefix: Buffer, solutionNonce: bigint, difficultyBits: number): boolean {
  const nonceBuf = Buffer.alloc(8);
  let x = solutionNonce;
  for (let i = 0; i < 8; i++) { nonceBuf[i] = Number(x & 0xffn); x >>= 8n; }
  const h = createHash('sha256').update(noncePrefix).update(nonceBuf).digest();
  return trailingZeroBits(h) >= difficultyBits;
}

/** Test helper: brute-force a small solution. */
export function findSolutionForTest(prefix: Buffer, bits: number): bigint {
  for (let i = 0n; i < 1_000_000n; i++) {
    if (verifySolution(prefix, i, bits)) return i;
  }
  throw new Error(`no solution within bound for ${bits} bits`);
}
```

- [ ] **Step 3: Run + commit**

```bash
npm --workspace @rpow/server test -- pow.test.ts
git add apps/server/src/pow.ts apps/server/tests/pow.test.ts
git commit -m "feat(server): PoW solution verifier"
```

### Task 4.3: POST /challenge

**Files:**
- Create: `apps/server/src/routes/challenge.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/challenge.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/challenge.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email = 'a@b.com'): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return r.headers['set-cookie'] as string;
}

describe('POST /challenge', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('issues a challenge to a logged-in user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.nonce_prefix).toMatch(/^[0-9a-f]+$/);
    expect(body.difficulty_bits).toBe(8);
  });

  it('rejects unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Implement routes/challenge.ts**

`apps/server/src/routes/challenge.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { readSession } from './auth.js';

export async function challengeRoutes(app: FastifyInstance) {
  app.post('/challenge', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const id = randomUUID();
    const noncePrefix = randomBytes(16);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const difficulty = Math.max(app.config.difficultyFloor, app.config.difficultyBits);
    await app.pool.query(
      'INSERT INTO challenges(id, user_email, nonce_prefix, difficulty_bits, expires_at) VALUES($1,$2,$3,$4,$5)',
      [id, s.email, noncePrefix, difficulty, expiresAt],
    );
    return {
      challenge_id: id,
      nonce_prefix: noncePrefix.toString('hex'),
      difficulty_bits: difficulty,
      expires_at: expiresAt.toISOString(),
    };
  });
}
```

- [ ] **Step 3: Register in buildApp**

In `buildApp.ts` add `import { challengeRoutes } from './routes/challenge.js';` and `await app.register(challengeRoutes);`.

- [ ] **Step 4: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): POST /challenge"
```

### Task 4.4: POST /mint

**Files:**
- Create: `apps/server/src/routes/mint.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/mint.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/mint.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

async function loginAndChallenge(ctx: Awaited<ReturnType<typeof makeTestApp>>) {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  const cookie = r.headers['set-cookie'] as string;
  const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
  return { cookie, ch };
}

describe('POST /mint', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits a token on a valid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.value).toBe(1);
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.balance).toBe(1);
    expect(me.minted).toBe(1);
  });

  it('rejects invalid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SOLUTION');
  });

  it('rejects double-claim of same challenge', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const first = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('CHALLENGE_ALREADY_CLAIMED');
  });
});
```

- [ ] **Step 2: Implement routes/mint.ts**

`apps/server/src/routes/mint.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { verifySolution } from '../pow.js';
import { signTokenPayload } from '../signing.js';
import { withTx } from '../db.js';

const Body = z.object({ challenge_id: z.string().uuid(), solution_nonce: z.string().regex(/^\d{1,20}$/) });

export async function mintRoutes(app: FastifyInstance) {
  app.post('/mint', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const result = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{ id: string; nonce_prefix: Buffer; difficulty_bits: number; expires_at: Date; claimed_at: Date | null }>(
        'SELECT id, nonce_prefix, difficulty_bits, expires_at, claimed_at FROM challenges WHERE id=$1 AND user_email=$2 FOR UPDATE',
        [parsed.data.challenge_id, s.email],
      );
      const ch = rows[0];
      if (!ch) return { error: 'BAD_REQUEST' as const, message: 'unknown challenge' };
      if (ch.claimed_at) return { error: 'CHALLENGE_ALREADY_CLAIMED' as const, message: 'already claimed' };
      if (ch.expires_at.getTime() < Date.now()) return { error: 'CHALLENGE_EXPIRED' as const, message: 'expired' };

      const nonce = BigInt(parsed.data.solution_nonce);
      if (!verifySolution(ch.nonce_prefix, nonce, ch.difficulty_bits)) {
        return { error: 'INVALID_SOLUTION' as const, message: 'hash does not meet difficulty' };
      }

      await c.query('UPDATE challenges SET claimed_at=now() WHERE id=$1', [ch.id]);

      const tokenId = randomUUID();
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(s.email).digest('hex');
      const sig = signTokenPayload(
        { id: tokenId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         VALUES($1, $2, 1, 'VALID', $3, $4)`,
        [tokenId, s.email, issuedAt, sig],
      );
      return { token: { id: tokenId, value: 1, issued_at: issuedAt.toISOString() } };
    });

    if ('error' in result) {
      const status = result.error === 'CHALLENGE_EXPIRED' ? 410 : 400;
      return reply.code(status).send(result);
    }
    return result;
  });
}
```

- [ ] **Step 3: Register in buildApp**

```ts
import { mintRoutes } from './routes/mint.js';
// ...
await app.register(mintRoutes);
```

- [ ] **Step 4: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): POST /mint with PoW verification + Ed25519 sig"
```

---

## Phase 5 — Transfers + activity

### Task 5.1: POST /send (happy + all error paths)

**Files:**
- Create: `apps/server/src/routes/send.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/send.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/send.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

describe('POST /send', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('transfers tokens between two registered users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const bCookie = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 3);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 2, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, transferred: 2, recipient_email: 'b@x.com' });

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(aMe.balance).toBe(1);
    expect(bMe.balance).toBe(2);
  });

  it('fails fast when recipient has no account', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 1);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'nobody@nowhere.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('RECIPIENT_NOT_FOUND');
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(1); // not invalidated
  });

  it('fails on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('idempotency: same key returns same result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 2);
    const key = randomUUID();
    const a = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    const b = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().transfer_id).toBe(b.json().transfer_id);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(1); // only one token transferred, not two
  });
});
```

- [ ] **Step 2: Implement routes/send.ts**

`apps/server/src/routes/send.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const Body = z.object({
  recipient_email: z.string().email(),
  amount: z.number().int().positive().max(1_000_000),
  idempotency_key: z.string().min(8).max(80),
});

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const amount = parsed.data.amount;
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });

    const out = await withTx(app.pool, async (c) => {
      const existing = await c.query<{ id: string; recipient_email: string; amount: number }>(
        'SELECT id, recipient_email, amount FROM transfers WHERE idempotency_key=$1', [idem],
      );
      if (existing.rows[0]) {
        return { ok: true as const, transferred: existing.rows[0].amount, recipient_email: existing.rows[0].recipient_email, transfer_id: existing.rows[0].id };
      }

      const exists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);
      if (!exists.rowCount) return { error: 'RECIPIENT_NOT_FOUND' as const, message: 'recipient has no rpow2 account', status: 404 };

      const lockSql = `SELECT id FROM tokens
        WHERE owner_email=$1 AND state='VALID'
        ORDER BY issued_at ASC
        LIMIT $2 FOR UPDATE SKIP LOCKED`;
      const { rows: locked } = await c.query<{ id: string }>(lockSql, [sender, amount]);
      if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };

      const transferId = randomUUID();
      const ownerHash = createHash('sha256').update(recipient).digest('hex');
      const issuedAt = new Date();

      for (const t of locked) {
        const newId = randomUUID();
        const sig = signTokenPayload(
          { id: newId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
           VALUES($1, $2, 1, 'VALID', $3, $4, $5)`,
          [newId, recipient, issuedAt, t.id, sig],
        );
      }

      await c.query(
        'INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key) VALUES($1,$2,$3,$4,$5)',
        [transferId, sender, recipient, amount, idem],
      );
      return { ok: true as const, transferred: amount, recipient_email: recipient, transfer_id: transferId };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });
}
```

- [ ] **Step 3: Register in buildApp + run + commit**

```ts
import { sendRoutes } from './routes/send.js';
await app.register(sendRoutes);
```

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): POST /send with atomic invalidate+reissue, fail-fast unknown recipient, idempotency"
```

### Task 5.2: GET /activity

**Files:**
- Create: `apps/server/src/routes/activity.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/activity.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/activity.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}
async function mineN(ctx: any, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

describe('GET /activity', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('shows mint, send, receive entries', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 2);
    await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: a, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: randomUUID() } });

    const aAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    const bAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: b } })).json();
    expect(aAct.find((e: any) => e.type === 'mint')).toBeTruthy();
    expect(aAct.find((e: any) => e.type === 'send' && e.counterparty_email === 'b@x.com')).toBeTruthy();
    expect(bAct.find((e: any) => e.type === 'receive' && e.counterparty_email === 'a@x.com')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement routes/activity.ts**

`apps/server/src/routes/activity.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const sql = `
      SELECT 'mint' AS type, value AS amount, NULL::text AS counterparty_email, issued_at AS at
      FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL
      UNION ALL
      SELECT 'send' AS type, amount, recipient_email AS counterparty_email, created_at AS at
      FROM transfers WHERE sender_email=$1
      UNION ALL
      SELECT 'receive' AS type, amount, sender_email AS counterparty_email, created_at AS at
      FROM transfers WHERE recipient_email=$1
      ORDER BY at DESC LIMIT 100`;
    const { rows } = await app.pool.query(sql, [s.email]);
    return rows.map(r => ({ ...r, at: r.at.toISOString() }));
  });
}
```

- [ ] **Step 3: Register + run + commit**

```ts
import { activityRoutes } from './routes/activity.js';
await app.register(activityRoutes);
```

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): GET /activity"
```

---

## Phase 6 — Public endpoints

### Task 6.1: GET /ledger

**Files:**
- Create: `apps/server/src/routes/ledger.ts`
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/ledger.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/ledger.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /ledger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('public, no auth, returns counters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/ledger' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      total_minted: 0, total_transferred: 0, circulating_supply: 0,
      current_difficulty_bits: 8, user_count: 0,
    });
  });
});
```

- [ ] **Step 2: Implement routes/ledger.ts**

`apps/server/src/routes/ledger.ts`:

```ts
import type { FastifyInstance } from 'fastify';

export async function ledgerRoutes(app: FastifyInstance) {
  app.get('/ledger', async () => {
    const [{ rows: minted }, { rows: transferred }, { rows: circ }, { rows: users }] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
    ]);
    return {
      total_minted: minted[0]!.n,
      total_transferred: transferred[0]!.n,
      circulating_supply: circ[0]!.n,
      current_difficulty_bits: Math.max(app.config.difficultyFloor, app.config.difficultyBits),
      user_count: users[0]!.n,
    };
  });
}
```

- [ ] **Step 3: Register + run + commit**

```ts
import { ledgerRoutes } from './routes/ledger.js';
await app.register(ledgerRoutes);
```

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): GET /ledger (public)"
```

### Task 6.2: GET /.well-known/rpow-pubkey.pem

**Files:**
- Modify: `apps/server/src/buildApp.ts`
- Create: `apps/server/tests/pubkey.test.ts`

- [ ] **Step 1: Test**

`apps/server/tests/pubkey.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /.well-known/rpow-pubkey.pem', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns the configured public key as PEM', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/.well-known/rpow-pubkey.pem' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-pem-file/);
    expect(res.body).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });
});
```

- [ ] **Step 2: Implement (inline in buildApp)**

In `apps/server/src/buildApp.ts`, before `return app;`:

```ts
  app.get('/.well-known/rpow-pubkey.pem', async (_req, reply) => {
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(app.config.signingPublicKeyHex, 'hex'),
    ]);
    const b64 = pubDer.toString('base64').match(/.{1,64}/g)!.join('\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
    reply.header('content-type', 'application/x-pem-file').send(pem);
  });
```

- [ ] **Step 3: Run + commit**

```bash
TEST_DATABASE_URL=postgres://postgres:p@localhost:55432/postgres npm --workspace @rpow/server test
git add apps/server
git commit -m "feat(server): public Ed25519 pubkey at /.well-known/rpow-pubkey.pem"
```

---

## Phase 7 — Web scaffold

### Task 7.1: Vite + React + TS scaffold

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/.env.example`

- [ ] **Step 1: Create apps/web/package.json**

```json
{
  "name": "@rpow/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.23.0",
    "hash-wasm": "^4.11.0",
    "@rpow/shared": "*"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "jsdom": "^24.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "references": [{ "path": "../../packages/shared" }]
}
```

- [ ] **Step 3: vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  worker: { format: 'es' },
});
```

- [ ] **Step 4: index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>rpow2 — a tribute to the original RPOW by Hal Finney</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: src/styles.css**

```css
:root {
  --bg: #0b0b0b;
  --fg: #e8e3d3;
  --accent: #6ee7b7;
  --dim: #6b6b6b;
  --error: #f87171;
}
:root[data-theme="amber"] { --fg: #ffb000; --accent: #ffb000; }
:root[data-theme="green"] { --fg: #5be09a; --accent: #5be09a; }

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  font-size: 14px;
  line-height: 1.5;
}
a { color: var(--accent); text-decoration: underline; }
button {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--fg);
  padding: 4px 12px;
  font: inherit;
  cursor: pointer;
}
button:hover { background: var(--fg); color: var(--bg); }
button:disabled { opacity: 0.4; cursor: not-allowed; }
input {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--dim);
  padding: 4px 8px;
  font: inherit;
  outline: none;
}
input:focus { border-color: var(--fg); }
.app-shell { max-width: 80ch; margin: 0 auto; padding: 16px; }
.tagline { color: var(--dim); font-size: 12px; }
.error { color: var(--error); }
```

- [ ] **Step 6: src/App.tsx**

```tsx
import { HashRouter, Route, Routes, Link } from 'react-router-dom';

export default function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <header>
          <pre>+======================================================================+
|  RPOW2 - Reusable Proofs of Work                            v0.1.0  |
+======================================================================+</pre>
          <div className="tagline">a tribute to the original rpow by hal finney</div>
          <nav><Link to="/">home</Link> · <Link to="/ledger">ledger</Link></nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<div>welcome.</div>} />
            <Route path="/ledger" element={<div>ledger TBD</div>} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
```

- [ ] **Step 7: src/main.tsx**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 8: .env.example**

```
VITE_API_BASE_URL=http://localhost:8080
```

- [ ] **Step 9: Install + dev sanity check**

```bash
npm install --workspace @rpow/web
npm --workspace @rpow/web run dev
# Open http://localhost:5173 — should see header + tagline. Ctrl-C.
```

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): vite+react scaffold with retro header"
```

### Task 7.2: API client + theme toggle

**Files:**
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/theme.ts`

- [ ] **Step 1: api.ts**

`apps/web/src/api.ts`:

```ts
import type {
  AuthRequestBody, AuthRequestResponse, MeResponse,
  ChallengeResponse, MintRequestBody, MintResponse,
  SendRequestBody, SendResponse, ActivityResponse, LedgerResponse, ApiError,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: ApiError;
    try { err = await res.json(); } catch { err = { error: 'INTERNAL', message: res.statusText }; }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  authRequest: (b: AuthRequestBody) => call<AuthRequestResponse>('POST', '/auth/request', b),
  me: () => call<MeResponse>('GET', '/me'),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  activity: () => call<ActivityResponse>('GET', '/activity'),
  ledger: () => call<LedgerResponse>('GET', '/ledger'),
};
```

- [ ] **Step 2: theme.ts**

`apps/web/src/theme.ts`:

```ts
const THEMES = ['default', 'amber', 'green'] as const;
export type Theme = (typeof THEMES)[number];

export function applyTheme(t: Theme) {
  if (t === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('rpow_theme', t);
}

export function loadTheme(): Theme {
  const t = localStorage.getItem('rpow_theme') as Theme | null;
  return t && THEMES.includes(t) ? t : 'default';
}

export function nextTheme(t: Theme): Theme {
  const i = THEMES.indexOf(t);
  return THEMES[(i + 1) % THEMES.length]!;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): API client and theme module"
```

### Task 7.3: AppShell with theme toggle + page layout

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/Panel.tsx`

- [ ] **Step 1: Panel component**

`apps/web/src/components/Panel.tsx`:

```tsx
import type { ReactNode } from 'react';

const HORIZ = '+----------------------------------------------------------------------+';

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={{ margin: '12px 0' }}>
      {title ? <pre style={{ margin: 0 }}>{`+-- ${title} ${'-'.repeat(Math.max(2, 66 - title.length))}+`}</pre> : <pre style={{ margin: 0 }}>{HORIZ}</pre>}
      <div style={{ padding: '8px 12px' }}>{children}</div>
      <pre style={{ margin: 0 }}>{HORIZ}</pre>
    </section>
  );
}
```

- [ ] **Step 2: Update App.tsx with theme toggle + nav**

`apps/web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, Link, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);

  return (
    <HashRouter>
      <div className="app-shell">
        <header>
          <pre>+======================================================================+
|  RPOW2 - Reusable Proofs of Work                            v0.1.0  |
+======================================================================+</pre>
          <div className="tagline">a tribute to the original rpow by hal finney</div>
          <nav style={{ marginTop: 8 }}>
            <NavLink to="/">[ wallet ]</NavLink>{' '}
            <NavLink to="/mine">[ mine ]</NavLink>{' '}
            <NavLink to="/send">[ send ]</NavLink>{' '}
            <NavLink to="/activity">[ activity ]</NavLink>{' '}
            <NavLink to="/ledger">[ ledger ]</NavLink>{' '}
            <NavLink to="/login">[ login ]</NavLink>{' · '}
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<div>(wallet placeholder)</div>} />
            <Route path="/login" element={<div>(login placeholder)</div>} />
            <Route path="/mine" element={<div>(mine placeholder)</div>} />
            <Route path="/send" element={<div>(send placeholder)</div>} />
            <Route path="/activity" element={<div>(activity placeholder)</div>} />
            <Route path="/ledger" element={<div>(ledger placeholder)</div>} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): AppShell, theme toggle, nav, Panel component"
```

---

## Phase 8 — Web auth pages

### Task 8.1: useMe hook + Login page

**Files:**
- Create: `apps/web/src/hooks/useMe.ts`
- Create: `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: useMe.ts**

`apps/web/src/hooks/useMe.ts`:

```ts
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { MeResponse } from '@rpow/shared';

export function useMe(): { me: MeResponse | null; loading: boolean; refresh: () => Promise<void> } {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try { setMe(await api.me()); } catch { setMe(null); } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  return { me, loading, refresh };
}
```

- [ ] **Step 2: Login.tsx**

`apps/web/src/pages/Login.tsx`:

```tsx
import { useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending'); setError('');
    try {
      await api.authRequest({ email });
      setStatus('sent');
    } catch (err: any) {
      setStatus('error');
      setError(err?.message ?? 'unknown error');
    }
  }

  return (
    <Panel title="LOGIN">
      <form onSubmit={submit}>
        <div>
          EMAIL : <input value={email} onChange={e => setEmail(e.target.value)} required type="email" autoFocus style={{ width: '36ch' }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending' || status === 'sent'}>
            {status === 'sending' ? '[ ... ]' : status === 'sent' ? '[ LINK SENT ]' : '[ SEND LINK ]'}
          </button>
        </div>
        {status === 'sent' && <div style={{ marginTop: 8 }}>check your inbox. the link expires in 15 minutes.</div>}
        {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      </form>
    </Panel>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

In `App.tsx`, replace the `/login` route element with `<LoginPage />` and import it.

- [ ] **Step 4: Sanity check + commit**

```bash
npm --workspace @rpow/web run dev
# Visit http://localhost:5173/#/login, enter an email, click. (You need server running for the request to succeed.)
git add apps/web/src
git commit -m "feat(web): Login page + useMe hook"
```

### Task 8.2: Wallet page

**Files:**
- Create: `apps/web/src/pages/Wallet.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Wallet.tsx**

```tsx
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';

export function WalletPage() {
  const { me, loading, refresh } = useMe();
  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return (
    <Panel title="WALLET">
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}>
        <Link to="/login">[ go to login ]</Link>
      </div>
    </Panel>
  );

  async function logout() {
    await api.logout();
    await refresh();
  }

  return (
    <Panel title="WALLET">
      <pre style={{ margin: 0 }}>
{`  > LOGGED IN AS: ${me.email}
  > BALANCE     : ${String(me.balance).padStart(4, '0')} RPOW
  > MINTED      : ${String(me.minted).padStart(4, '0')}
  > SENT        : ${String(me.sent).padStart(4, '0')}
  > RECEIVED    : ${String(me.received).padStart(4, '0')}
`}
      </pre>
      <div style={{ marginTop: 8 }}>
        <Link to="/mine">[ MINE ]</Link>{' '}
        <Link to="/send">[ SEND ]</Link>{' '}
        <Link to="/activity">[ ACTIVITY ]</Link>{' '}
        <button onClick={logout}>[ LOGOUT ]</button>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 2: Wire `/` route to WalletPage; commit**

In `App.tsx` replace `/` element with `<WalletPage />` and import it.

```bash
git add apps/web/src
git commit -m "feat(web): Wallet page with balance + counters"
```

---

## Phase 9 — Web mining

### Task 9.1: Web Worker for SHA-256 mining

**Files:**
- Create: `apps/web/src/miner.worker.ts`
- Create: `apps/web/src/pages/Mine.tsx`

- [ ] **Step 1: Worker**

`apps/web/src/miner.worker.ts`:

```ts
import { createSHA256 } from 'hash-wasm';
import { trailingZeroBits, bytesFromHex } from '@rpow/shared';

type StartMsg = { type: 'start'; nonce_prefix: string; difficulty_bits: number };
type AbortMsg = { type: 'abort' };
type InMsg = StartMsg | AbortMsg;

let aborted = false;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'abort') { aborted = true; return; }

  aborted = false;
  const prefix = bytesFromHex(msg.nonce_prefix);
  const target = msg.difficulty_bits;

  const sha = await createSHA256();
  const buf = new Uint8Array(prefix.length + 8);
  buf.set(prefix, 0);

  const startedAt = performance.now();
  let last = startedAt;
  let count = 0n;
  let nonce = 0n;

  while (!aborted) {
    let x = nonce;
    for (let i = 0; i < 8; i++) { buf[prefix.length + i] = Number(x & 0xffn); x >>= 8n; }
    sha.init();
    sha.update(buf);
    const digest = sha.digest('binary'); // Uint8Array
    if (trailingZeroBits(digest) >= target) {
      (self as any).postMessage({ type: 'found', solution_nonce: nonce.toString(), hashes: count.toString() });
      return;
    }
    nonce++;
    count++;
    if ((count & 0xffffn) === 0n) {
      const now = performance.now();
      if (now - last > 250) {
        (self as any).postMessage({ type: 'progress', hashes: count.toString(), elapsed_ms: Math.round(now - startedAt) });
        last = now;
      }
    }
  }
  (self as any).postMessage({ type: 'aborted' });
};
```

- [ ] **Step 2: Mine page**

`apps/web/src/pages/Mine.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';

type Status = 'idle' | 'mining' | 'submitting' | 'minted' | 'error';

export function MinePage() {
  const { me, loading, refresh } = useMe();
  const nav = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [target, setTarget] = useState<number | null>(null);
  const [hashes, setHashes] = useState('0');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [tokenId, setTokenId] = useState('');
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  async function start() {
    if (!me) { nav('/login'); return; }
    setStatus('mining'); setError(''); setHashes('0'); setElapsed(0);
    const ch = await api.challenge();
    setTarget(ch.difficulty_bits);
    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = async (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') { setHashes(m.hashes); setElapsed(m.elapsed_ms); return; }
      if (m.type === 'aborted') { setStatus('idle'); return; }
      if (m.type === 'found') {
        setStatus('submitting');
        try {
          const r = await api.mint({ challenge_id: ch.challenge_id, solution_nonce: m.solution_nonce });
          setTokenId(r.token.id);
          setStatus('minted');
          await refresh();
        } catch (err: any) {
          setStatus('error');
          setError(err?.message ?? 'mint failed');
        } finally { w.terminate(); workerRef.current = null; }
      }
    };
    w.postMessage({ type: 'start', nonce_prefix: ch.nonce_prefix, difficulty_bits: ch.difficulty_bits });
  }

  function abort() {
    workerRef.current?.postMessage({ type: 'abort' });
  }

  function fmtRate() {
    if (!elapsed) return '0';
    const h = Number(hashes);
    const mhs = (h / 1e6) / (elapsed / 1000);
    return mhs.toFixed(2) + ' MH/s';
  }
  function fmtElapsed() {
    const s = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `00:${mm}:${ss}`;
  }

  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return <Panel title="MINE"><div>not signed in.</div></Panel>;

  return (
    <Panel title="MINE">
      <pre style={{ margin: 0 }}>
{`  TARGET    : ${target ?? '--'} trailing zero bits
  HASHES    : ${Number(hashes).toLocaleString()}
  RATE      : ${fmtRate()}
  ELAPSED   : ${fmtElapsed()}
  STATUS    : ${status.toUpperCase()}${tokenId ? `\n  TOKEN     : ${tokenId}` : ''}${error ? `\n  ERROR     : ${error}` : ''}
`}
      </pre>
      <div style={{ marginTop: 8 }}>
        {status === 'idle' || status === 'minted' || status === 'error' ? (
          <button onClick={start}>[ MINE ]</button>
        ) : (
          <button onClick={abort}>[ ABORT ]</button>
        )}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3: Wire route + commit**

In `App.tsx`, set `/mine` element to `<MinePage />`.

```bash
git add apps/web
git commit -m "feat(web): Mine page with WASM SHA-256 worker"
```

### Task 9.2: Manual end-to-end smoke

- [ ] **Step 1: Bring up Postgres + server**

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16
sleep 3
# Generate a server keypair for the dev environment:
node -e 'const {generateKeypair}=require("./apps/server/dist/signing.js"); const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+"\nRPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);' > .keys.env
# Build server first so the keygen works (npm run build)
npm run build --workspace @rpow/server
# Now start with low difficulty to actually feel mining at desk speed
DATABASE_URL=postgres://postgres:p@localhost:55432/postgres \
RESEND_API_KEY=re_test EMAIL_FROM='rpow4 <no-reply@rpow4.com>' \
SESSION_SECRET=$(openssl rand -hex 32) \
MAGIC_LINK_BASE_URL=http://localhost:8080 \
DIFFICULTY_BITS=20 DIFFICULTY_FLOOR=8 \
WEB_ORIGIN=http://localhost:5173 \
$(cat .keys.env | xargs) \
npm --workspace @rpow/server run dev
```

- [ ] **Step 2: In another terminal, bring up the web client**

```bash
npm --workspace @rpow/web run dev
```

- [ ] **Step 3: Manually smoke-test**

- Visit `http://localhost:5173/#/login`. Submit `frk314@gmail.com`.
- Tail server logs, find magic link printed by Resend's dev mode (or use a real Resend key for a real send). Open link in browser.
- After redirect lands on `/#/wallet`, click `[ MINE ]`. Watch live counters; wait for token. Balance increments to 1.

This is a manual checkpoint — no commit; we verify wiring before deploy.

---

## Phase 10 — Web send + activity + ledger

### Task 10.1: Send page

**Files:**
- Create: `apps/web/src/pages/Send.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Send.tsx**

```tsx
import { useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';

export function SendPage() {
  const { me, refresh } = useMe();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState(1);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setStatus('sending'); setError('');
    try {
      const r = await api.send({ recipient_email: recipient, amount, idempotency_key: crypto.randomUUID() });
      setStatus('sent'); setTransferId(r.transfer_id);
      await refresh();
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        RECIPIENT_NOT_FOUND: 'recipient has no rpow2 account',
        INSUFFICIENT_BALANCE: 'not enough tokens in your wallet',
        BAD_REQUEST: err?.message ?? 'bad request',
      };
      setError(msgs[code] ?? code);
    }
  }

  if (!me) return <Panel title="SEND"><div>not signed in.</div></Panel>;

  return (
    <Panel title="SEND">
      <form onSubmit={submit}>
        <div>TO     : <input type="email" required value={recipient} onChange={e => setRecipient(e.target.value)} style={{ width: '40ch' }} /></div>
        <div style={{ marginTop: 4 }}>AMOUNT : <input type="number" min={1} max={me.balance} required value={amount} onChange={e => setAmount(Number(e.target.value))} style={{ width: '10ch' }} /> RPOW</div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending'}>[ {status === 'sending' ? '...' : 'SEND'} ]</button>
        </div>
      </form>
      {status === 'sent' && <div style={{ marginTop: 8 }}>+ sent. transfer id: {transferId}</div>}
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </Panel>
  );
}
```

- [ ] **Step 2: Wire + commit**

In `App.tsx`, set `/send` to `<SendPage />`.

```bash
git add apps/web/src
git commit -m "feat(web): Send page"
```

### Task 10.2: Activity + Ledger pages

**Files:**
- Create: `apps/web/src/pages/Activity.tsx`
- Create: `apps/web/src/pages/Ledger.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Activity.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { ActivityEntry } from '@rpow/shared';

export function ActivityPage() {
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.activity().then(setItems).catch(e => setError(e?.message ?? 'failed')); }, []);
  if (error) return <Panel title="ACTIVITY"><div className="error">{error}</div></Panel>;
  if (!items) return <Panel title="ACTIVITY"><div>loading...</div></Panel>;
  return (
    <Panel title="ACTIVITY">
      <pre style={{ margin: 0 }}>
{items.length === 0 ? '  (no activity yet)' : items.map(e => {
  const when = e.at.replace('T', ' ').slice(0, 19);
  const who = e.counterparty_email ?? '';
  const tag = e.type.toUpperCase().padEnd(8);
  const amt = `${e.type === 'send' ? '-' : '+'}${e.amount}`;
  return `  ${when}  ${tag}  ${amt.padStart(4)}  ${who}`;
}).join('\n')}
      </pre>
    </Panel>
  );
}
```

- [ ] **Step 2: Ledger.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { LedgerResponse } from '@rpow/shared';

export function LedgerPage() {
  const [d, setD] = useState<LedgerResponse | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  return (
    <Panel title="PUBLIC LEDGER">
      <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${d.total_minted}
  TOTAL TRANSFERRED   : ${d.total_transferred}
  CIRCULATING SUPPLY  : ${d.circulating_supply}
  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
  USER COUNT          : ${d.user_count}
`}
      </pre>
      <div style={{ marginTop: 12 }} className="tagline">
        a tribute to the original rpow by hal finney —
        <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer"> finney's announcement</a>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3: Wire + commit**

In `App.tsx`, set `/activity` and `/ledger` elements.

```bash
git add apps/web/src
git commit -m "feat(web): Activity and Ledger pages"
```

---

## Phase 11 — End-to-end test

### Task 11.1: Playwright happy path

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/happy-path.spec.ts`
- Modify: `apps/web/package.json` (add Playwright)

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test --workspace @rpow/web
npx playwright install --with-deps chromium
```

- [ ] **Step 2: playwright.config.ts**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173', headless: true },
  webServer: [
    {
      command: 'npm --workspace @rpow/web run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

- [ ] **Step 3: e2e/happy-path.spec.ts**

```ts
import { test, expect, request } from '@playwright/test';

const SERVER = process.env.E2E_SERVER ?? 'http://localhost:8080';

test('mine, send, balance updates', async ({ page, browser }) => {
  // Helper: login a given email by reading the magic link from the server's test inbox.
  async function login(email: string) {
    const ctx = await request.newContext();
    await ctx.post(`${SERVER}/auth/request`, { data: { email } });
    // In E2E mode the server is started with TEST_FAKE_EMAIL=true and exposes the last link via /test/last-link/:email.
    const r = await ctx.get(`${SERVER}/test/last-link/${encodeURIComponent(email)}`);
    expect(r.ok()).toBeTruthy();
    const link = (await r.json()).link as string;
    await page.goto(link);
    await page.waitForURL(/#\/wallet/);
  }

  await login('e2e-a@x.com');
  await page.goto('/#/mine');
  await page.getByRole('button', { name: /MINE/ }).click();
  await page.waitForFunction(() => /STATUS\s*:\s*MINTED/.test(document.body.textContent ?? ''), null, { timeout: 60_000 });

  await page.goto('/#/send');
  // Ensure recipient exists in this run by logging them in once in another context.
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  // separate session so we don't replace the original cookie
  await p2.goto('about:blank');
  const ctx = await request.newContext();
  await ctx.post(`${SERVER}/auth/request`, { data: { email: 'e2e-b@x.com' } });
  const r = await ctx.get(`${SERVER}/test/last-link/${encodeURIComponent('e2e-b@x.com')}`);
  const link = (await r.json()).link;
  await p2.goto(link);

  // Back on the original page, send 1 to b.
  await page.fill('input[type=email]', 'e2e-b@x.com');
  await page.fill('input[type=number]', '1');
  await page.getByRole('button', { name: /SEND/ }).click();
  await expect(page.locator('text=transfer id:')).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 4: Server test-only endpoint for last-link**

Add to `apps/server/src/buildApp.ts` (gated on a flag):

```ts
  if (process.env.RPOW_TEST_INBOX === 'true') {
    app.get('/test/last-link/:email', async (req, reply) => {
      const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
      const last = (app.mailer as any).lastTo?.(email);
      if (!last) return reply.code(404).send({});
      const m = (last.text as string).match(/https?:\/\/[^\s]+token=[\w-]+/);
      return { link: m?.[0] };
    });
  }
```

- [ ] **Step 5: package.json E2E script**

In `apps/web/package.json` add:

```json
  "scripts": {
    "e2e": "playwright test"
  }
```

- [ ] **Step 6: Run + commit**

```bash
# Ensure server is running with RPOW_TEST_INBOX=true and DIFFICULTY_BITS=8 + FakeMailer
# (in CI we'll wire this up; locally, restart the dev server with those vars)
RPOW_TEST_INBOX=true DIFFICULTY_BITS=8 DIFFICULTY_FLOOR=4 npm --workspace @rpow/server run dev &
npm --workspace @rpow/web run e2e
git add apps/web apps/server
git commit -m "test(web): playwright happy-path E2E (login → mine → send)"
```

---

## Phase 12 — Deploy

### Task 12.1: Server Dockerfile + Fly config

**Files:**
- Create: `apps/server/Dockerfile`
- Create: `apps/server/.dockerignore`
- Create: `fly.toml`

- [ ] **Step 1: Dockerfile**

`apps/server/Dockerfile`:

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm ci --workspaces --include-workspace-root
RUN npm run build --workspace @rpow/shared
RUN npm run build --workspace @rpow/server

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/package.json /repo/package-lock.json /app/
COPY --from=build /repo/packages/shared /app/packages/shared
COPY --from=build /repo/apps/server /app/apps/server
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
```

- [ ] **Step 2: .dockerignore**

```
node_modules
dist
build
.git
.env
.env.local
test-results
playwright-report
coverage
```

- [ ] **Step 3: fly.toml**

`fly.toml`:

```toml
app = "rpow2-server"
primary_region = "iad"

[build]
  dockerfile = "apps/server/Dockerfile"

[env]
  PORT = "8080"
  WEB_ORIGIN = "https://rpow4.com"
  MAGIC_LINK_BASE_URL = "https://api.rpow4.com"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "15s"
    timeout = "3s"
```

- [ ] **Step 4: Commit (do NOT deploy yet — secrets next)**

```bash
git add apps/server/Dockerfile apps/server/.dockerignore fly.toml
git commit -m "chore(deploy): server Dockerfile + Fly config"
```

### Task 12.2: Fly secrets + Neon DB + first deploy

This task has shell steps the operator runs once. There's no application code in it.

- [ ] **Step 1: Provision Neon DB**

```bash
# Manually:
# 1. Sign up at neon.tech.
# 2. Create project "rpow2", branch "main".
# 3. Copy the pooled connection string (postgres://...?sslmode=require).
# 4. Save as $NEON_URL in your shell.
```

- [ ] **Step 2: Provision Resend**

```bash
# Manually:
# 1. Sign up at resend.com.
# 2. Verify domain rpow4.com (add SPF/DKIM/DMARC records to Cloudflare DNS as Resend prompts).
# 3. Create API key. Save as $RESEND_KEY.
```

- [ ] **Step 3: Generate Ed25519 keypair**

```bash
node -e 'import("./apps/server/dist/signing.js").then(({generateKeypair})=>{const k=generateKeypair();console.log(JSON.stringify(k))})' > keypair.json
PRIV=$(jq -r .privateHex keypair.json)
PUB=$(jq -r .publicHex keypair.json)
rm keypair.json
```

- [ ] **Step 4: Create Fly app + push secrets + deploy**

```bash
flyctl apps create rpow2-server
flyctl secrets set \
  DATABASE_URL="$NEON_URL" \
  RESEND_API_KEY="$RESEND_KEY" \
  EMAIL_FROM='rpow4 <no-reply@rpow4.com>' \
  SESSION_SECRET=$(openssl rand -hex 32) \
  RPOW_SIGNING_PRIVATE_KEY_HEX="$PRIV" \
  RPOW_SIGNING_PUBLIC_KEY_HEX="$PUB" \
  DIFFICULTY_BITS=28 \
  DIFFICULTY_FLOOR=20 \
  --app rpow2-server
flyctl deploy --app rpow2-server
flyctl status --app rpow2-server
```

Expected: `flyctl status` shows the machine running. `curl https://rpow2-server.fly.dev/health` returns `{"ok":true}`.

- [ ] **Step 5: Map api.rpow4.com to Fly**

```bash
# In Cloudflare DNS, add CNAME api → rpow2-server.fly.dev (proxied off, "DNS only" for Fly TLS).
flyctl certs create api.rpow4.com --app rpow2-server
```

### Task 12.3: Cloudflare Pages for the web app

- [ ] **Step 1: Build settings (one-time, in Cloudflare dashboard)**

- New Pages project → Connect to GitHub repo.
- Build command: `npm install && npm run build --workspace @rpow/shared && npm run build --workspace @rpow/web`
- Output directory: `apps/web/dist`
- Environment variables: `VITE_API_BASE_URL=https://api.rpow4.com`
- Production branch: `main`

- [ ] **Step 2: Custom domain**

- Add `rpow4.com` and `www.rpow4.com` to the Pages project.
- Cloudflare provisions TLS automatically.

- [ ] **Step 3: Commit a CI helper README note**

Append to `README.md` (create if missing):

```md
# rpow2

A tribute to Hal Finney's RPOW (2004), modernized.

## Deploy

- Server: Fly.io app `rpow2-server` (api.rpow4.com)
- Web: Cloudflare Pages (rpow4.com)
- DB: Neon Postgres
- Email: Resend
```

```bash
git add README.md
git commit -m "docs: deploy notes in README"
```

### Task 12.4: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: ci.yml**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: p, POSTGRES_DB: rpow_test }
        ports: ["55432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s --health-timeout 5s --health-retries 5
    env:
      TEST_DATABASE_URL: postgres://postgres:p@localhost:55432/rpow_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.20.0', cache: 'npm' }
      - run: npm ci
      - run: npm run build --workspace @rpow/shared
      - run: npm run build --workspace @rpow/server
      - run: npm test
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only --app rpow2-server
        env: { FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }} }
```

- [ ] **Step 2: Add FLY_API_TOKEN to GitHub repo secrets**

In GitHub UI: Settings → Secrets and variables → Actions → Add `FLY_API_TOKEN` from `flyctl auth token`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions test + Fly deploy on main"
```

---

## Phase 13 — Final smoke + docs

### Task 13.1: README and operator runbook

**Files:**
- Modify: `README.md`
- Create: `docs/RUNBOOK.md`

- [ ] **Step 1: Expand README**

```md
# rpow2

> A tribute to the original RPOW by Hal Finney.

A faithful modern recreation of Hal Finney's [Reusable Proofs of Work](https://nakamotoinstitute.org/finney/rpow/) (2004). Magic-link auth, hashcash mining (~30s on a modern MacBook), Ed25519-signed tokens, email-keyed transfers, public ledger.

## Local dev

Requires Node 22 and Docker.

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16
npm install
npm run build --workspace @rpow/shared
npm test
```

To run the stack with low difficulty for hands-on testing:

```bash
# In one terminal
DATABASE_URL=postgres://postgres:p@localhost:55432/postgres \
RESEND_API_KEY=re_test EMAIL_FROM='rpow4 <no-reply@rpow4.com>' \
SESSION_SECRET=$(openssl rand -hex 32) \
MAGIC_LINK_BASE_URL=http://localhost:8080 WEB_ORIGIN=http://localhost:5173 \
DIFFICULTY_BITS=20 DIFFICULTY_FLOOR=8 \
RPOW_TEST_INBOX=true \
$(node -e 'const {generateKeypair}=require("./apps/server/dist/signing.js"); const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+" RPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);') \
npm --workspace @rpow/server run dev

# In another terminal
npm --workspace @rpow/web run dev
```

## Deploy

- Server: Fly.io (`api.rpow4.com`)
- Web: Cloudflare Pages (`rpow4.com`)
- DB: Neon Postgres
- Email: Resend

See `docs/RUNBOOK.md` for operator instructions.
```

- [ ] **Step 2: docs/RUNBOOK.md**

```md
# Operator Runbook

## Deploys
- Pushing to `main` triggers GitHub Actions: tests → Fly deploy.
- Manual server deploy: `flyctl deploy --app rpow2-server`.
- Web deploys automatically on Cloudflare Pages.

## Secrets (Fly)
- `flyctl secrets list --app rpow2-server`
- Required: `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `SESSION_SECRET`, `RPOW_SIGNING_PRIVATE_KEY_HEX`, `RPOW_SIGNING_PUBLIC_KEY_HEX`, `DIFFICULTY_BITS`, `DIFFICULTY_FLOOR`.

## Difficulty changes
- Bump `DIFFICULTY_BITS` via `flyctl secrets set DIFFICULTY_BITS=30 --app rpow2-server`.
- Floor: `DIFFICULTY_FLOOR` is the absolute minimum the server will ever issue.

## Rotating the signing key
1. Generate new keypair; store new private key.
2. Add second public key to a future `JWKS`-style endpoint (not in v1 — currently single key).
3. Restart Fly machine.
4. Old tokens remain verifiable until you remove the old key.

## Database
- `flyctl ssh console --app rpow2-server` then `psql $DATABASE_URL` for read-only inspection.
- Backups: nightly `pg_dump` to R2 (set up separately; not in v1 plan).

## Common tasks
- Reset a user's account (testing): `DELETE FROM tokens WHERE owner_email='X'; DELETE FROM transfers WHERE sender_email='X' OR recipient_email='X'; DELETE FROM users WHERE email='X';`
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/RUNBOOK.md
git commit -m "docs: README + operator runbook"
```

### Task 13.2: Final manual smoke against production

- [ ] **Step 1: Open https://rpow4.com**, request a magic link to your real email
- [ ] **Step 2: Click the email link, land on /#/wallet**
- [ ] **Step 3: Mine one token (will take ~30s at DIFFICULTY_BITS=28)**
- [ ] **Step 4: Send 1 RPOW to a friend's email; confirm fail-fast if they have no account**
- [ ] **Step 5: Have your friend log in via magic link, mine their own; send back**
- [ ] **Step 6: Visit /#/ledger from a logged-out tab; confirm public counters move**

If all six pass, v1 is shipped.

---

## Plan self-review

- **Spec coverage:** every spec section maps to a task — auth (3.x), mining (4.x), transfer with fail-fast (5.x), public endpoints (6.x), retro UX (7–10.x), abuse mitigations (3.6 + the difficulty floor in env), testing (11.x), hosting (12.x).
- **Placeholder scan:** none (`(wallet placeholder)` etc. in App.tsx are momentary scaffolds replaced by later tasks; `lastTo?` cast in test-inbox endpoint is intentional because that helper exists only on `FakeMailer`).
- **Type consistency:** `MeResponse`, `ChallengeResponse`, `MintResponse`, `SendResponse`, `ApiError` all referenced consistently across server/web. `solution_nonce` is `string` (decimal of u64) end-to-end. `nonce_prefix` is hex string end-to-end. Token state enum stays `VALID | INVALIDATED` everywhere.
- **Scope check:** mobile is intentionally out, called out in the header. Plan ships a working web product on its own.
