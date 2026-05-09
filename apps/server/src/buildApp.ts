import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
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

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    config: AppConfig;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
    bodyLimit: 16 * 1024,
    // Honor X-Forwarded-For only when the connection comes from nginx on
    // localhost. trustProxy here so per-IP rate limiting (if added in the
    // future) sees the real client IP rather than 127.0.0.1.
    trustProxy: '127.0.0.1',
  });

  app.decorate('pool', opts.pool);
  app.decorate('config', opts.config);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(cors, {
    origin: opts.config.webOrigin,
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(signupRoutes);
  await app.register(meRoutes);
  await app.register(accountRoutes);
  await app.register(challengeRoutes);
  await app.register(mintRoutes);
  await app.register(sendRoutes);
  await app.register(activityRoutes);
  await app.register(ledgerRoutes);

  app.get('/.well-known/rpow-pubkey.pem', async (_req, reply) => {
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(app.config.signingPublicKeyHex, 'hex'),
    ]);
    const b64 = pubDer.toString('base64').match(/.{1,64}/g)!.join('\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
    reply.header('content-type', 'application/x-pem-file').send(pem);
  });

  return app;
}
