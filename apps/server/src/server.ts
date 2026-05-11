import { parseEnv } from './env.js';
import { createPool, runMigrations, attachPoolErrorLogger } from './db.js';
import { buildApp } from './buildApp.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
});
await runMigrations(pool);

const app = await buildApp({
  pool,
  config: {
    sessionSecret: env.SESSION_SECRET,
    difficultyStartBits: env.DIFFICULTY_BITS,
    difficultyStepBlocks: env.DIFFICULTY_STEP_BLOCKS,
    difficultyMaxBits: env.DIFFICULTY_MAX_BITS,
    signupDifficultyBits: env.SIGNUP_DIFFICULTY_BITS,
    mintMaxSupply: env.MINT_MAX_SUPPLY,
    baseRewardBaseUnits: env.MINT_BASE_REWARD_BASE_UNITS,
    halvingIntervalBlocks: env.HALVING_INTERVAL_BLOCKS,
    sendBaseFeeBaseUnits: env.SEND_BASE_FEE_BASE_UNITS,
    faucetEnabled: env.FAUCET_ENABLED,
    faucetClaimAmountBaseUnits: env.FAUCET_CLAIM_AMOUNT_BASE_UNITS,
    faucetCooldownHours: env.FAUCET_COOLDOWN_HOURS,
    trollboxPostFeeBaseUnits: env.TROLLBOX_POST_FEE_BASE_UNITS,
    poolEnabled: env.POOL_ENABLED,
    poolFeeBps: env.POOL_FEE_BPS,
    poolFinderBps: env.POOL_FINDER_BPS,
    poolShareBits: env.POOL_SHARE_BITS,
    poolChallengeTtlSeconds: env.POOL_CHALLENGE_TTL_SECONDS,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
    secureCookies: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY ? true : '127.0.0.1',
  },
});

// Replace the createPool default no-op error handler with structured
// logging now that we have a pino instance from Fastify.
attachPoolErrorLogger(pool, (msg, err) => app.log.error({ err }, msg));

await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow4 server listening on :${env.PORT}`);

/**
 * Graceful shutdown: drain in-flight HTTP requests before tearing the
 * pool down. The order matters — closing the pool first would 500 every
 * still-running request. Idempotent so a double-signal (e.g. SIGINT
 * during a SIGTERM-triggered shutdown) doesn't crash the process.
 */
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutdown requested');
  // Hard deadline so a stuck request doesn't keep the process alive
  // forever and prevent orchestrator restarts.
  const hardDeadline = setTimeout(() => {
    app.log.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);
  hardDeadline.unref();
  try {
    await app.close();
    await pool.end();
    app.log.info('clean shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException');
  // Don't keep running with potentially corrupt state. The orchestrator
  // will restart us cleanly.
  void shutdown('SIGTERM');
});
