import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
    // Each test spins up a fresh Postgres schema and runs migrations; under
    // the parallel forks pool the per-test wall-clock can spike when many
    // suites are racing on the same DB. 30s is well clear of all currently
    // passing test wall-clocks while still catching genuinely hung tests.
    testTimeout: 30_000,
  },
});
