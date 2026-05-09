import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env.js';

const baseValid = {
  DATABASE_URL: 'postgres://u:p@h/db',
  SESSION_SECRET: 'a'.repeat(32),
  RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
  RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
};

describe('parseEnv', () => {
  it('parses a valid env', () => {
    const env = parseEnv({ ...baseValid, DIFFICULTY_BITS: '8' });
    expect(env.DIFFICULTY_BITS).toBe(8);
  });

  it('rejects when DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects when SESSION_SECRET is too short', () => {
    expect(() => parseEnv({ ...baseValid, SESSION_SECRET: 'too-short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects malformed signing keys', () => {
    expect(() => parseEnv({
      ...baseValid,
      RPOW_SIGNING_PRIVATE_KEY_HEX: 'not-hex',
    })).toThrow(/RPOW_SIGNING_PRIVATE_KEY_HEX/);
  });

  it('defaults optional envs sensibly', () => {
    const env = parseEnv(baseValid);
    expect(env.SIGNUP_DIFFICULTY_BITS).toBe(18);
  });
});
