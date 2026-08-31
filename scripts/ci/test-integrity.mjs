#!/usr/bin/env node
/**
 * Stops the most common way an agent turns a red build green: deleting or
 * skipping the test instead of fixing the code.
 *
 *  - no `.skip` / `.only` / `xit` / `xdescribe` anywhere in tests
 *  - total test count must not fall below the baseline recorded on main
 *
 * Usage:
 *   node scripts/ci/test-integrity.mjs                 # check
 *   node scripts/ci/test-integrity.mjs --write-baseline
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const BASELINE = '.ci/test-baseline.json';
const REPORT = '.ci/reports/guard-test-integrity.json';
const violations = [];

const SKIP_PATTERNS = [
  { re: /\b(?:describe|it|test)\.skip\s*\(/g, what: '.skip(' },
  { re: /\b(?:describe|it|test)\.only\s*\(/g, what: '.only(' },
  { re: /\b(?:xit|xdescribe|fit|fdescribe)\s*\(/g, what: 'x/f-prefixed test' },
  { re: /\btest\.fixme\s*\(/g, what: '.fixme(' },
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const testFiles = (await Promise.all(['tests', 'e2e'].map((d) => walk(d).catch(() => [])))).flat();

for (const file of testFiles) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  for (const { re, what } of SKIP_PATTERNS) {
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({
          file: relative(process.cwd(), file),
          line: i + 1,
          rule: 'no-skipped-tests',
          message: `Disabled test (${what}). Fix the code or delete the feature — do not skip.`,
        });
      }
    });
  }
}

// --- test count -------------------------------------------------------------
async function countTests() {
  let total = 0;
  const dir = '.ci/reports';
  const files = await readdir(dir).catch(() => []);
  for (const f of files) {
    if (!f.startsWith('vitest')) continue;
    const report = JSON.parse(await readFile(join(dir, f), 'utf8'));
    total += report.numTotalTests ?? 0;
  }
  return total;
}

const count = await countTests();

if (process.argv.includes('--write-baseline')) {
  await writeFile(BASELINE, JSON.stringify({ testCount: count }, null, 2) + '\n');
  console.log(`Baseline written: ${count} tests`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(BASELINE, 'utf8').catch(() => '{"testCount":0}'));
if (count < baseline.testCount) {
  violations.push({
    file: BASELINE,
    line: null,
    rule: 'test-count-regression',
    message: `Test count dropped from ${baseline.testCount} to ${count}. Removing tests requires human review.`,
  });
}

await writeFile(
  REPORT,
  JSON.stringify({ tool: 'test-integrity', testCount: count, violations }, null, 2),
).catch(() => undefined);

if (violations.length) {
  console.error(`test-integrity: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v.file}:${v.line ?? '-'} ${v.message}`);
  process.exit(1);
}
console.log(`test-integrity: ok (${count} tests, baseline ${baseline.testCount})`);
