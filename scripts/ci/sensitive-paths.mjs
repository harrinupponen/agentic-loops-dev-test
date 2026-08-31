#!/usr/bin/env node
/**
 * Applies the `needs-human` label deterministically, based on which paths a PR
 * touches. Agent judgement about "is this sensitive?" is not reliable enough to
 * be the gate, so the gate is a path list plus CODEOWNERS.
 *
 * Prints a newline-separated list of triggered reasons; empty output = no gate.
 * Usage: node scripts/ci/sensitive-paths.mjs <base-ref>
 */
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';

const RULES = [
  [/^src\/plugins\/auth\.ts$/, 'authentication logic'],
  [/^src\/routes\/auth\.ts$/, 'authentication routes'],
  [/^src\/lib\/(password|session)\.ts$/, 'credential and session handling'],
  [/^drizzle\/.*\.sql$/, 'database migration'],
  [/^src\/db\/schema\.ts$/, 'database schema'],
  [/^\.github\//, 'CI/CD configuration'],
  [/^scripts\/ci\//, 'CI gate scripts'],
  [/^Dockerfile$|^docker-compose\.yml$|^scripts\/docker-entrypoint\.sh$/, 'infrastructure'],
  [/^package-lock\.json$/, 'dependency changes'],
  [/^vitest\.config\.ts$|^playwright\.config\.ts$|^eslint\.config\.js$/, 'quality gate configuration'],
  [/^\.ci\/test-baseline\.json$/, 'test baseline'],
  [/^openapi\.json$/, 'public API contract'],
];

const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const reasons = new Set();
for (const file of changed) {
  for (const [re, reason] of RULES) if (re.test(file)) reasons.add(reason);
}

process.stdout.write([...reasons].join('\n'));
