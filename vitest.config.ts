import { defineConfig } from 'vitest/config';

// NOTE: coverage thresholds are a merge gate. Lowering them requires a CODEOWNERS
// review (see .github/CODEOWNERS). Agents must not edit this file to make CI pass.
export default defineConfig({
  test: {
    // Vitest 5 removed vitest.workspace.ts; projects live in the root config.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          hookTimeout: 180_000,
          testTimeout: 30_000,
          // One DB, one process: keeps truncation between tests deterministic.
          // (Vitest 5 replaced poolOptions.forks.singleFork with these.)
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
