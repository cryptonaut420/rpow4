import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import type { Pool } from 'pg';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { accountRoutes } from './routes/account.js';
import { signupRoutes } from './routes/signup.js';
import { challengeRoutes } from './routes/challenge.js';
import { mintRoutes } from './routes/mint.js';
import { sendRoutes } from './routes/send.js';
import { activityRoutes } from './routes/activity.js';
import { ledgerRoutes } from './routes/ledger.js';
import { statsRoutes } from './routes/stats.js';
import { explorerRoutes } from './routes/explorer.js';
import { faucetRoutes } from './routes/faucet.js';
import { trollboxRoutes } from './routes/trollbox.js';
import { claimRoutes } from './routes/claim.js';
import { TtlCache, type CachedJsonResponse } from './cache.js';
import { pingPool } from './db.js';
import { createCachedSessionVerifier, SESSION_COOKIE, type CachedSessionVerifier } from './session.js';

export interface AppConfig {
  sessionSecret: string;
  /** Trailing-zero-bit difficulty at block height 0 (RPOW4 schedule start). */
  difficultyStartBits: number;
  /** Blocks between difficulty +1-bit steps. */
  difficultyStepBlocks: number;
  /** Hard cap on stamped difficulty so the schedule stays mineable forever. */
  difficultyMaxBits: number;
  /** PoW difficulty for /signup (anti-spam, not currency). */
  signupDifficultyBits: number;
  /** 21,000,000 in production. Express in whole RPOW; base-unit cap is derived. */
  mintMaxSupply: number;
  /** Initial block reward in base units. 50 RPOW = 50_000_000_000 in production. */
  baseRewardBaseUnits: bigint;
  /** Blocks between reward halvings. 210,000 in production (Bitcoin-exact). */
  halvingIntervalBlocks: number;
  /** Per-send fee in base units at halving 0. Halves with every reward halving. */
  sendBaseFeeBaseUnits: bigint;
  /** Faucet on/off switch. */
  faucetEnabled: boolean;
  /** Amount granted by each successful faucet claim, in base units. */
  faucetClaimAmountBaseUnits: bigint;
  /** Cooldown between faucet claims for the same pubkey or IP. */
  faucetCooldownHours: number;
  /** Trollbox post fee in base units, paid to the treasury per message. */
  trollboxPostFeeBaseUnits: bigint;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
  secureCookies: boolean;
  trustProxy: boolean | string;
}

export interface BuildAppOptions {
  test?: boolean;
  pool: Pool;
  config: AppConfig;
}

/**
 * Per-app caches. They live for the lifetime of the FastifyInstance and
 * are invalidated explicitly by write paths (mint/send/signup/account)
 * via `app.invalidateAccount(pubkey)` and `app.invalidateLookup(name)`.
 *
 * TTLs are kept short (1–2s for hot user-scoped data, 5s for ledger
 * aggregates, 30s for handle lookups) so any missed invalidation is
 * still bounded.
 */
export interface AppCaches {
  /** Per-pubkey /me responses. */
  me: TtlCache<string, unknown>;
  /** Per-pubkey /activity responses. */
  activity: TtlCache<string, unknown>;
  /** Per (lower-cased) display-name /lookup responses; null = miss. */
  lookup: TtlCache<string, unknown | null>;
  /** Public /ledger and /ledger/stats pre-serialized response. */
  ledger: TtlCache<'singleton', CachedJsonResponse>;
  /** Public /ledger/events pre-serialized pages, keyed by cursor + limit. */
  ledgerEvents: TtlCache<string, CachedJsonResponse>;
  /** Public /stats/leaderboard top-100 pre-serialized response, keyed by sort variant. */
  leaderboard: TtlCache<string, CachedJsonResponse>;
  /** Public /explorer/feed pre-serialized pages, keyed by cursor|limit. */
  explorerFeed: TtlCache<string, CachedJsonResponse>;
  /** Public /explorer/tx/:id pre-serialized responses, keyed by tx UUID. Immutable — no invalidation. */
  explorerTx: TtlCache<string, CachedJsonResponse | null>;
  /** Public /explorer/account/:pubkey first-page responses, keyed by pubkey. */
  explorerAccount: TtlCache<string, unknown>;
  /** Public /faucet status (treasury balance + global config). Per-caller cache key. */
  faucetStatus: TtlCache<string, unknown>;
  /** Public /trollbox feed pre-serialized pages, keyed by cursor|limit. */
  trollboxFeed: TtlCache<string, CachedJsonResponse>;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    config: AppConfig;
    caches: AppCaches;
    /**
     * Verify the session cookie on a request and return the caller's
     * pubkey, or null if the cookie is missing/invalid/expired. Cached
     * per-token to skip HMAC + JSON.parse on every authed request.
     */
    readSession: (req: FastifyRequest) => { pubkey: string } | null;
    /** Process-local cached session verifier (test/diagnostics access). */
    sessionVerifier: CachedSessionVerifier;
    /** Drop cached /me and /activity for a single pubkey. */
    invalidateAccount: (pubkey: string) => void;
    /** Drop cached /lookup for a display name (case-insensitive). */
    invalidateLookup: (name: string | null | undefined) => void;
    /** Drop cached public ledger aggregates and event pages. */
    invalidateLedger: () => void;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
    bodyLimit: 16 * 1024,
    // Dev only trusts localhost proxies. Production Docker runs behind
    // Cloudflare -> nginx-proxy -> container hops, so compose enables broader
    // proxy trust through TRUST_PROXY=true.
    trustProxy: opts.config.trustProxy,
  });

  app.decorate('pool', opts.pool);
  app.decorate('config', opts.config);

  const sessionVerifier = createCachedSessionVerifier(opts.config.sessionSecret);
  app.decorate('sessionVerifier', sessionVerifier);
  app.decorate('readSession', (req: FastifyRequest) => {
    const tok = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    if (!tok) return null;
    return sessionVerifier(tok);
  });

  const caches: AppCaches = {
    me: new TtlCache<string, unknown>({ ttlMs: 2_000, maxSize: 50_000 }),
    activity: new TtlCache<string, unknown>({ ttlMs: 2_000, maxSize: 50_000 }),
    lookup: new TtlCache<string, unknown | null>({ ttlMs: 30_000, maxSize: 50_000 }),
    ledger: new TtlCache<'singleton', CachedJsonResponse>({ ttlMs: 5_000, maxSize: 1 }),
    ledgerEvents: new TtlCache<string, CachedJsonResponse>({ ttlMs: 1_500, maxSize: 256 }),
    // Leaderboard moves slowly — the rerank only matters when balances
    // shift. 10s TTL keeps load tiny while still feeling live. Two sort
    // variants ('balance' | 'minted') share the same cache, hence
    // maxSize=2 and a string key.
    leaderboard: new TtlCache<string, CachedJsonResponse>({ ttlMs: 10_000, maxSize: 2 }),
    explorerFeed: new TtlCache<string, CachedJsonResponse>({ ttlMs: 3_000, maxSize: 256 }),
    // Tx details are immutable; a long TTL avoids redundant DB reads.
    explorerTx: new TtlCache<string, CachedJsonResponse | null>({ ttlMs: 3_600_000, maxSize: 10_000 }),
    explorerAccount: new TtlCache<string, unknown>({ ttlMs: 3_000, maxSize: 50_000 }),
    // Faucet status: treasury balance + caller-specific eligibility. Short
    // TTL because the visible "next claim at" countdown should feel live.
    faucetStatus: new TtlCache<string, unknown>({ ttlMs: 2_000, maxSize: 20_000 }),
    // Trollbox feed: invalidated explicitly on every post; short TTL is a
    // safety net so a missed invalidation can't pin stale messages.
    trollboxFeed: new TtlCache<string, CachedJsonResponse>({ ttlMs: 3_000, maxSize: 256 }),
  };
  app.decorate('caches', caches);
  app.decorate('invalidateAccount', (pubkey: string) => {
    caches.me.invalidate(pubkey);
    caches.activity.invalidate(pubkey);
    caches.explorerAccount.invalidate(pubkey);
  });
  app.decorate('invalidateLookup', (name: string | null | undefined) => {
    if (!name) return;
    caches.lookup.invalidate(name.toLowerCase());
  });
  app.decorate('invalidateLedger', () => {
    caches.ledger.clear();
    caches.ledgerEvents.clear();
    // Mints + transfers both shift balances; if they invalidate /ledger
    // they should also invalidate the leaderboard so rankings stay live.
    caches.leaderboard.clear();
    // Explorer feed shows recent network events — clear on every new event.
    caches.explorerFeed.clear();
    // Faucet status surfaces treasury balance + global config; treasury
    // balance changes whenever the ledger advances.
    caches.faucetStatus.clear();
    // /ledger surfaces trollbox_message_count, so a new post (which also
    // shifts treasury) needs to drop the trollbox feed cache too.
    caches.trollboxFeed.clear();
  });

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(cors, {
    origin: opts.config.webOrigin,
    credentials: true,
  });

  // Wire-level compression for JSON. Brotli first (better ratio at
  // similar CPU cost on Node 20+), gzip fallback for older clients.
  // The 1 KB threshold avoids compressing tiny responses where the
  // overhead exceeds the savings.
  if (!opts.test) {
    await app.register(compress, {
      global: true,
      threshold: 1024,
      encodings: ['br', 'gzip', 'deflate'],
    });
  }

  // Rate limiting is intentionally disabled in this codebase. PoW-mining
  // at the dev difficulty (DIFFICULTY_BITS=14) sustains hundreds of
  // requests per second per client by design, which doesn't fit a
  // request-rate-bucket abuse model. When prod abuse protection is
  // needed, prefer a layer in front of the API (Cloudflare, nginx, or
  // similar) over re-introducing the in-process plugin.

  // Slow-request observability. Logs any request slower than 250ms with
  // route, method, status, and duration so operators can spot regressions
  // without enabling full request logging.
  if (!opts.test) {
    const SLOW_REQUEST_MS = 250;
    app.addHook('onResponse', async (req, reply) => {
      const elapsed = reply.elapsedTime;
      if (elapsed >= SLOW_REQUEST_MS) {
        req.log.warn(
          { method: req.method, url: req.url, statusCode: reply.statusCode, elapsedMs: Math.round(elapsed) },
          'slow request',
        );
      }
    });
  }

  // Health-probe response shapes are tiny and stable: declare schemas so
  // Fastify routes them through fast-json-stringify and skips the slower
  // generic JSON.stringify path. Probes hit at high frequency from load
  // balancers, so even a sub-millisecond reduction matters.
  const healthSchema = {
    response: {
      200: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
  } as const;
  const healthReadySchema = {
    response: {
      200: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, db: { type: 'string' } },
        required: ['ok', 'db'],
        additionalProperties: false,
      },
      503: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, db: { type: 'string' } },
        required: ['ok', 'db'],
        additionalProperties: false,
      },
    },
  } as const;

  /**
   * Liveness: process is up. Cheap, no DB hop. Used by load balancers.
   */
  app.get('/health', { schema: healthSchema }, async () => ({ ok: true }));

  /**
   * Readiness: process is up AND can talk to Postgres. Used by
   * orchestrators that should withhold traffic from a node that can't
   * serve real requests.
   */
  app.get('/health/ready', { schema: healthReadySchema }, async (_req, reply) => {
    const ok = await pingPool(opts.pool);
    if (!ok) return reply.code(503).send({ ok: false, db: 'down' });
    return { ok: true, db: 'ok' };
  });

  await app.register(authRoutes);
  await app.register(signupRoutes);
  await app.register(meRoutes);
  await app.register(accountRoutes);
  await app.register(challengeRoutes);
  await app.register(mintRoutes);
  await app.register(sendRoutes);
  await app.register(activityRoutes);
  await app.register(ledgerRoutes);
  await app.register(statsRoutes);
  await app.register(explorerRoutes);
  await app.register(faucetRoutes);
  await app.register(trollboxRoutes);
  await app.register(claimRoutes);

  // Public-key PEM is fully determined by the signing config; precompute
  // once at startup instead of rebuilding on every request.
  const pubDer = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(app.config.signingPublicKeyHex, 'hex'),
  ]);
  const pubPem = `-----BEGIN PUBLIC KEY-----\n${pubDer.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
  app.get('/.well-known/rpow-pubkey.pem', async (_req, reply) => {
    reply
      .header('content-type', 'application/x-pem-file')
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(pubPem);
  });

  return app;
}
