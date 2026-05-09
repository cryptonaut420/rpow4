import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
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
import { TtlCache, type CachedJsonResponse } from './cache.js';
import { pingPool } from './db.js';
import { createCachedSessionVerifier, SESSION_COOKIE, type CachedSessionVerifier } from './session.js';

export interface AppConfig {
  sessionSecret: string;
  difficultyBits: number;
  difficultyFloor: number;
  signupDifficultyBits: number;
  mintMaxSupply: number;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
  secureCookies: boolean;
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
    // Honor X-Forwarded-For only when the connection comes from nginx on
    // localhost. trustProxy here so per-IP rate limiting sees the real
    // client IP rather than 127.0.0.1.
    trustProxy: '127.0.0.1',
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
  };
  app.decorate('caches', caches);
  app.decorate('invalidateAccount', (pubkey: string) => {
    caches.me.invalidate(pubkey);
    caches.activity.invalidate(pubkey);
  });
  app.decorate('invalidateLookup', (name: string | null | undefined) => {
    if (!name) return;
    caches.lookup.invalidate(name.toLowerCase());
  });
  app.decorate('invalidateLedger', () => {
    caches.ledger.clear();
    caches.ledgerEvents.clear();
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

  // Per-IP rate limit. The plugin uses an in-memory bucket store; that's
  // intentional — we don't want a Redis dep. Limits are conservative
  // global ceilings; the hot write endpoints set tighter per-route
  // overrides via { config: { rateLimit: { max, timeWindow } } }.
  //
  // Tests skip rate-limit registration entirely so high-fan-out test
  // suites don't trip 429s on rapid-fire injects.
  if (!opts.test) {
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      cache: 50_000,
      // skipOnError keeps the API up if the limiter implementation throws
      // — degrade open rather than 5xx the world.
      skipOnError: true,
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: 'TOO_MANY_REQUESTS',
        message: `rate limit exceeded; retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      }),
    });
  }

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
