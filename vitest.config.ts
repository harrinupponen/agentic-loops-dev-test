import { defineConfig } from 'vitest/config';

// NOTE: coverage thresholds are a merge gate. Lowering them requires a CODEOWNERS
// review (see .github/CODEOWNERS). Agents must not edit this file to make CI pass.
export default defineConfig({
  test: {
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
