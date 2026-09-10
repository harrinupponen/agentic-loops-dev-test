#!/usr/bin/env node
// Proves the pipeline the unit and integration suites cannot: that the BUILT
// output, started the way the container starts it, patches `pg` in time and
// actually ships spans over OTLP. Exits non-zero on any failure.
//
//   npm run build && npm run verify:tracing      (or: make verify-tracing)
//
// Needs a Postgres. DATABASE_URL, or the one from docker-compose.yml.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
const APP_PORT = 3999;
const SINK_PORT = 4399;
const TITLE = `verify-tracing-${Math.random().toString(36).slice(2)}`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

for (const file of ['dist/index.js', 'dist/telemetry.js', 'dist/public/index.html']) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

// An OTLP/HTTP sink. This exporter serialises JSON, so no protobuf is needed.
const received = [];
const sink = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/v1/traces') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      for (const resource of body.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) received.push({ scope: scope.scope?.name, span });
        }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((resolve) => sink.listen(SINK_PORT, '127.0.0.1', resolve));

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(APP_PORT),
  HOST: '127.0.0.1',
  DATABASE_URL,
  COOKIE_SECRET: 'verify-tracing-cookie-secret-32-characters',
  ALLOWED_ORIGINS: `http://127.0.0.1:${APP_PORT}`,
  MAIL_TRANSPORT: 'drop',
  SHUTDOWN_GRACE_MS: '0',
  LOG_LEVEL: 'warn',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${SINK_PORT}`,
  TRACE_SAMPLE_RATIO: '1.0',
};

await new Promise((resolve, reject) => {
  const migrate = spawn('node', ['dist/db/migrate.js'], { env, stdio: 'inherit' });
  migrate.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('migrations failed'))));
});

// Exactly the command in scripts/docker-entrypoint.sh.
const server = spawn('node', ['--import', './dist/telemetry.js', 'dist/index.js'], {
  env,
  stdio: 'inherit',
});
server.on('exit', (code) => {
  if (code !== 0 && code !== null) failures.push(`server exited with code ${code}`);
});

const base = `http://127.0.0.1:${APP_PORT}`;
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`${base}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) await sleep(100);
  }
  check(up, 'the built server boots with --import ./dist/telemetry.js');
  if (!up) throw new Error('server never became healthy');

  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `verify-${Date.now()}@example.com`,
      password: 'correct-horse-battery-staple',
    }),
  });
  const cookie = String(registered.headers.getSetCookie()[0]).split(';')[0];

  const created = await fetch(`${base}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: TITLE }),
  });
  check(created.status === 201, 'POST /api/todos succeeds against the built server');

  // The batch delay is 5s and nothing has elapsed, so anything that arrives
  // from here on was flushed by the shutdown path rather than exported on time.
  const beforeSigterm = received.length;
  server.kill('SIGTERM');
  for (let i = 0; i < 100 && server.exitCode === null; i++) await sleep(100);
  check(server.exitCode === 0, 'SIGTERM exits cleanly');
  check(received.length > beforeSigterm, 'SIGTERM flushes the batch rather than dropping it');

  const serverSpan = received.find((s) => s.span.name === 'POST /api/todos')?.span;
  check(Boolean(serverSpan), 'a server span for POST /api/todos arrives at the collector');

  const pgSpans = received.filter(
    (s) =>
      s.scope === '@opentelemetry/instrumentation-pg' && s.span.traceId === serverSpan?.traceId,
  );
  check(pgSpans.length > 0, 'at least one pg span shares the trace id (--import patched pg)');
  check(
    pgSpans.every((s) => s.span.parentSpanId),
    'pg spans are children, never orphans',
  );

  // `db.statement` in the older semantic conventions; this version of
  // instrumentation-pg emits the stable `db.query.text`. Either way it must be
  // the parameterised SQL, with the values elided.
  const statements = pgSpans.flatMap((s) =>
    (s.span.attributes ?? [])
      .filter((a) => a.key === 'db.query.text' || a.key === 'db.statement')
      .map((a) => a.value?.stringValue ?? ''),
  );
  check(
    statements.length > 0 && statements.some((sql) => sql.includes('$1')),
    'pg spans carry the parameterised query text',
  );
  check(
    pgSpans.every((s) => !JSON.stringify(s.span.attributes ?? []).includes(TITLE)),
    'no pg span attribute carries a literal value from the request body',
  );
} finally {
  server.kill('SIGKILL');
  sink.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
