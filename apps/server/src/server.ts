import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
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
    difficultyBits: env.DIFFICULTY_BITS,
    difficultyFloor: env.DIFFICULTY_FLOOR,
    signupDifficultyBits: env.SIGNUP_DIFFICULTY_BITS,
    mintMaxSupply: env.MINT_MAX_SUPPLY,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
    secureCookies: env.NODE_ENV === 'production',
  },
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow2 server listening on :${env.PORT}`);
