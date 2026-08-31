#!/usr/bin/env node
/**
 * Normalises every tool's output into one flat JSON list of findings.
 *
 * This exists for the fixer agent. Raw Actions logs are ANSI-laden and
 * tool-specific; agents scrape them badly and invent causes. One file with a
 * predictable shape turns "read the logs" into "read ci-failures.json".
 *
 * Usage: node scripts/ci/summarize-ci.mjs <reports-dir> > ci-failures.json
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.ci/reports';
const findings = [];

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};
const readText = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

const push = (f) => findings.push({ severity: 'error', ...f });

// --- eslint -----------------------------------------------------------------
for (const file of await safeReaddir(dir)) {
  if (!file.startsWith('eslint')) continue;
  const results = await readJson(join(dir, file));
  for (const r of results ?? []) {
    for (const m of r.messages ?? []) {
      if (m.severity !== 2) continue;
      push({
        tool: 'eslint',
        file: relative(r.filePath),
        line: m.line ?? null,
        column: m.column ?? null,
        rule: m.ruleId ?? null,
        message: m.message,
      });
    }
  }
}

// --- typescript -------------------------------------------------------------
const tsc = await readText(join(dir, 'tsc.txt'));
for (const line of (tsc ?? '').split('\n')) {
  // src/app.ts(12,5): error TS2345: Argument of type ...
  const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
  if (!m) continue;
  push({ tool: 'tsc', file: m[1], line: Number(m[2]), column: Number(m[3]), rule: m[4], message: m[5] });
}

// --- vitest -----------------------------------------------------------------
for (const file of await safeReaddir(dir)) {
  if (!file.startsWith('vitest')) continue;
  const report = await readJson(join(dir, file));
  for (const suite of report?.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      push({
        tool: 'vitest',
        file: relative(suite.name ?? ''),
        line: null,
        rule: assertion.fullName ?? assertion.title,
        message: firstLine(assertion.failureMessages?.join('\n') ?? 'test failed'),
      });
    }
  }
}

// --- playwright -------------------------------------------------------------
const pw = await readJson(join(dir, 'playwright.json'));
if (pw) {
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const failed = (test.results ?? []).some((r) => r.status === 'failed' || r.status === 'timedOut');
          if (!failed) continue;
          push({
            tool: 'playwright',
            file: relative(spec.file ?? suite.file ?? ''),
            line: spec.line ?? null,
            rule: spec.title,
            message: firstLine(
              test.results?.flatMap((r) => (r.error ? [r.error.message ?? ''] : [])).join('\n') ||
                'e2e test failed',
            ),
          });
        }
      }
      walk(suite.suites);
    }
  };
  walk(pw.suites);
}

// --- gate scripts (guards, migration safety, test integrity) ----------------
for (const file of await safeReaddir(dir)) {
  if (!file.startsWith('guard-')) continue;
  const report = await readJson(join(dir, file));
  for (const v of report?.violations ?? []) {
    push({ tool: report.tool ?? file.replace('.json', ''), ...v });
  }
}

// --- k6 ---------------------------------------------------------------------
const k6 = await readJson(join(dir, 'k6-summary.json'));
for (const [name, metric] of Object.entries(k6?.metrics ?? {})) {
  for (const [threshold, result] of Object.entries(metric.thresholds ?? {})) {
    if (result.ok !== false) continue;
    push({
      tool: 'k6',
      file: 'load/smoke.js',
      line: null,
      rule: `${name}: ${threshold}`,
      message: `Load threshold breached (${name} ${threshold}). p95=${metric.values?.['p(95)'] ?? 'n/a'}`,
    });
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  failureCount: findings.length,
  byTool: countBy(findings, (f) => f.tool),
  findings,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');

// --- helpers ----------------------------------------------------------------
async function safeReaddir(d) {
  try {
    return await readdir(d);
  } catch {
    return [];
  }
}
function relative(p) {
  return String(p).replace(process.cwd() + '/', '');
}
function firstLine(s) {
  return String(s).split('\n').slice(0, 4).join(' ').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 500);
}
function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
