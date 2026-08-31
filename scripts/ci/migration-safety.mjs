#!/usr/bin/env node
/**
 * Enforces expand/contract on database changes.
 *
 * Rule 1 — a migration may not be edited once merged. Applied files are
 *          immutable; changing one means some environments have the old version.
 * Rule 2 — a destructive migration (DROP / RENAME / NOT NULL on an existing
 *          column) may not ship in the same PR as application code. The old
 *          version keeps running during a rolling deploy; if this PR removes
 *          what it reads, requests fail mid-deploy.
 *
 * Usage: node scripts/ci/migration-safety.mjs <base-ref>
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'origin/main';
const REPORT = '.ci/reports/guard-migration-safety.json';
const violations = [];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const changed = git('diff', '--name-status', `${base}...HEAD`)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status: status[0], path: paths.at(-1) };
  });

const migrations = changed.filter((c) => c.path?.startsWith('drizzle/') && c.path.endsWith('.sql'));
const appCode = changed.filter((c) => c.path?.startsWith('src/'));

// Rule 1: no edits to existing migrations.
for (const m of migrations) {
  if (m.status === 'M' || m.status === 'D' || m.status === 'R') {
    violations.push({
      file: m.path,
      line: null,
      rule: 'immutable-migrations',
      message:
        'Applied migrations are append-only. Add a new migration instead of editing this one.',
    });
  }
}

// Rule 2: destructive DDL must ship alone.
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i,
  /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
  /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i,
  /\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i,
];

for (const m of migrations.filter((x) => x.status === 'A')) {
  const body = git('show', `HEAD:${m.path}`);
  const hit = DESTRUCTIVE.find((re) => re.test(body));
  if (hit && appCode.length > 0) {
    violations.push({
      file: m.path,
      line: null,
      rule: 'expand-contract',
      message:
        'Destructive migration shipped alongside src/ changes. Split into two PRs: (1) stop using the column, deploy; (2) drop it.',
    });
  }
  if (/\bCREATE\s+INDEX\b/i.test(body) && !/\bCREATE\s+INDEX\s+CONCURRENTLY\b/i.test(body)) {
    violations.push({
      file: m.path,
      line: null,
      rule: 'blocking-index',
      message:
        'CREATE INDEX takes a write lock on the table. Use CREATE INDEX CONCURRENTLY (outside a transaction) on tables with data.',
    });
  }
}

await writeFile(REPORT, JSON.stringify({ tool: 'migration-safety', violations }, null, 2)).catch(
  () => undefined,
);

if (violations.length) {
  console.error(`migration-safety: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v.file}: ${v.message}`);
  process.exit(1);
}
console.log('migration-safety: ok');
