import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['tests/integration/global-setup.ts'],
      hookTimeout: 180_000,
      testTimeout: 30_000,
      // One DB, one process: keeps truncation between tests deterministic.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
