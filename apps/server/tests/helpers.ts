import { createPool, runMigrations } from '../src/db.js';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/buildApp.js';
import {
  generateMnemonic,
  mnemonicToKeypair,
  signCanonical,
  type CanonicalAction,
  type RpowKeypair,
} from '@rpow/shared';
import pg from 'pg';

export async function makeTestApp(opts: {
  signupDifficultyBits?: number;
  /** Override default 0 — use for send-fee behavior tests. */
  sendBaseFeeBaseUnits?: bigint;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  cleanup: () => Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL required');

  const schema = `t_${randomBytes(4).toString('hex')}`;

  // Use an admin pool to create the schema
  const adminPool = createPool(url);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await adminPool.end();

  // Create a pool that always uses this schema via search_path
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    options: `-c search_path=${schema}`,
  });

  await runMigrations(pool);
  // Override the seeded default asset row so its mining/cap parameters
  // match the legacy single-asset test fixture: 8-bit difficulty with the
  // step interval pushed well past any single test's block count, a
  // 21-RPOW cap, and a 1/128-RPOW reward so the cap-exhausted edge case
  // is reachable in a few mints. After migration 027 these knobs live on
  // the asset row, not in the AppConfig — but tests still need them to
  // stay constant within a run.
  await pool.query(
    `UPDATE assets
       SET difficulty_start_bits = 8,
           difficulty_step_blocks = 1000000,
           difficulty_max_bits = 50,
           initial_reward_base_units = 7812500,
           reward_interval_blocks = 1000000,
           max_supply_base_units = 21000000000
     WHERE id = '00000000-0000-4000-8000-000000000000'`,
  );
  const app = await buildApp({
    pool,
    test: true,
    config: {
      sessionSecret: 'x'.repeat(32),
      difficultyStartBits: 8,
      difficultyStepBlocks: 1_000_000,
      difficultyMaxBits: 50,
      signupDifficultyBits: opts.signupDifficultyBits ?? 8,
      mintMaxSupply: 21,
      baseRewardBaseUnits: 7_812_500n,
      halvingIntervalBlocks: 1_000_000,
      sendBaseFeeBaseUnits: opts.sendBaseFeeBaseUnits ?? 0n,
      faucetEnabled: true,
      faucetClaimAmountBaseUnits: 1_000_000n,
      faucetCooldownHours: 24,
      trollboxPostFeeBaseUnits: 0n,
      poolEnabled: true,
      poolFeeBps: 200,
      poolFinderBps: 2500,
      poolShareBits: 8,
      poolChallengeTtlSeconds: 300,
      signingPrivateKeyHex: '11'.repeat(32),
      signingPublicKeyHex: '22'.repeat(32),
      webOrigin: 'http://web.test',
      secureCookies: false,
      trustProxy: '127.0.0.1',
      rpow2ApiBaseUrl: 'http://rpow2.test',
      rpow2SessionCookie: 'rpow_session=test',
      rpow2BankerEmail: 'rpow4bank@gmail.com',
      rpow2DepositPollEnabled: false,
    },
  });
  return {
    app, pool,
    cleanup: async () => {
      await app.close();
      // Use a fresh pool to drop the schema since main pool may be closed
      const cleanPool = createPool(url);
      await cleanPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanPool.end();
      await pool.end();
    },
  };
}

export interface TestWallet extends RpowKeypair {
  cookie: string;
  /** Sign a canonical body with this wallet's secret key. */
  sign(action: CanonicalAction, body: unknown): string;
}

/**
 * Generate a fresh wallet, run the /auth/challenge → /auth/session flow,
 * and return the keypair + the resulting session cookie. Tests use the
 * cookie to authenticate subsequent calls and the sign() helper to
 * authorize per-event bodies.
 */
export async function loginAsRandomWallet(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<TestWallet> {
  const kp = mnemonicToKeypair(generateMnemonic());
  return loginAsWallet(app, kp);
}

export async function loginAsWallet(
  app: Awaited<ReturnType<typeof buildApp>>,
  kp: RpowKeypair,
): Promise<TestWallet> {
  const challengeRes = await app.inject({
    method: 'POST',
    url: '/auth/challenge',
    headers: { 'content-type': 'application/json' },
    payload: { pubkey: kp.publicKeyBase58 },
  });
  if (challengeRes.statusCode !== 200) {
    throw new Error(`/auth/challenge failed: ${challengeRes.statusCode} ${challengeRes.body}`);
  }
  const { envelope, envelope_mac } = challengeRes.json();
  const sig = signCanonical('auth.session', envelope, kp.secretKey);
  const sessionRes = await app.inject({
    method: 'POST',
    url: '/auth/session',
    headers: { 'content-type': 'application/json' },
    payload: { envelope, envelope_mac, signature_base58: sig },
  });
  if (sessionRes.statusCode !== 200) {
    throw new Error(`/auth/session failed: ${sessionRes.statusCode} ${sessionRes.body}`);
  }
  const cookie = sessionRes.headers['set-cookie'] as string;
  return {
    ...kp,
    cookie,
    sign: (action, body) => signCanonical(action, body, kp.secretKey),
  };
}
