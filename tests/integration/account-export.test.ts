import { sql } from 'drizzle-orm';
import http from 'node:http';
import { Writable } from 'node:stream';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents } from '../../src/db/schema.js';
import { hashSessionToken } from '../../src/lib/session.js';
import { EXPORT_BATCH_SIZE, EXPORT_RATE_LIMIT_MAX } from '../../src/routes/account.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

interface Line {
  type: string;
  [key: string]: unknown;
}

interface EndLine extends Line {
  counts: { todos: number; sessions: number; auditEvents: number };
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    AUTH_RATE_LIMIT_MAX: '10000',
    PASSWORD_RESET_RATE_LIMIT_MAX: '10000',
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDb(ctx.db);
});

const tokenOf = (cookie: string) => cookie.slice('sid='.length).split('.')[0]!;

const exportRaw = (cookie?: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/auth/export',
    ...(cookie ? { headers: { cookie } } : {}),
  });

/**
 * The document, line by line. Every line must parse on its own — the whole
 * body deliberately does not (ADR 0026), which the header case asserts.
 */
function parseLines(body: string): Line[] {
  const raw = body.split('\n');
  // A well-formed document ends with a newline, so the split leaves one empty
  // trailing element and nothing else empty.
  expect(raw.at(-1)).toBe('');
  return raw.slice(0, -1).map((line) => JSON.parse(line) as Line);
}

async function exported(cookie: string) {
  const res = await exportRaw(cookie);
  expect(res.statusCode).toBe(200);
  const lines = parseLines(res.body);
  return { res, lines, of: (type: string) => lines.filter((l) => l.type === type) };
}

function counterValue(body: string, name: string, labels: Record<string, string> = {}) {
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${name}{`) && line !== `${name} 0` && !line.startsWith(`${name} `)) {
      continue;
    }
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return 0;
}

const readMetrics = async (app = ctx.app) => {
  const res = await app.inject({ url: '/metrics', headers: metricsAuth() });
  expect(res.statusCode).toBe(200);
  return res.body;
};

/** Every statement the app's own pool runs, so "never touched" is checkable. */
function captureSql(pool: pg.Pool) {
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const statements: string[] = [];
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0] as string | { text?: string } | undefined;
    statements.push(typeof first === 'string' ? first : (first?.text ?? ''));
    return original(...args);
  };
  return {
    statements,
    reset: () => {
      statements.length = 0;
    },
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

/**
 * Seeds `count` todos one second apart, oldest first, titled `<prefix>-0`
 * upward.
 *
 * Inserted in SQL rather than through Drizzle on purpose: `now()` carries
 * microseconds, exactly as every row this application writes does, and a cursor
 * that cannot represent them re-emits the row it stopped on. A fixture built
 * from a JS Date has millisecond precision and hides that.
 */
function seedTodos(userId: string, count: number, prefix = 'todo') {
  return ctx.db.execute(sql`
    INSERT INTO todos (user_id, title, created_at, updated_at)
    SELECT ${userId}, ${prefix} || '-' || (g - 1)::text,
           now() - make_interval(secs => ${count} - g), now()
      FROM generate_series(1, ${count}) g`);
}

describe('GET /api/auth/export', () => {
  it('the export is served as a no-store ndjson attachment', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'headers-export@example.com');

    const res = await exportRaw(cookie);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="agentic-todo-export.ndjson"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    // A file named after its owner leaks that owner to everything that lists a
    // downloads directory.
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).not.toContain(user.email);
    expect(disposition).not.toContain('headers-export');
    expect(disposition).not.toContain(user.id);
  });

  it('the export is newline-delimited json between a header and a terminator', async () => {
    const { cookie } = await registerUser(ctx.app, 'ndjson-export@example.com');

    const { res, lines } = await exported(cookie);

    expect(lines.length).toBeGreaterThan(2);
    const header = lines[0]!;
    expect(Object.keys(header).sort()).toEqual(['exportedAt', 'format', 'type']);
    expect(header.type).toBe('export');
    expect(header.format).toBe('agentic-todo.export.v1');
    expect(String(header.exportedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines.at(-1)!.type).toBe('end');
    // The document is not a single JSON object, and that is the point.
    expect(() => JSON.parse(res.body) as unknown).toThrow();
  });

  it('exports todos including the trash, sessions and audit events', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'content-export@example.com');

    const kept = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'still here' },
    });
    const trashed = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'in the trash' },
    });
    expect(kept.statusCode).toBe(201);
    const trashedId = trashed.json<{ id: string }>().id;
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: `/api/todos/${trashedId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(204);

    const { lines, of } = await exported(cookie);

    const account = of('account');
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({ id: user.id, email: user.email, emailVerifiedAt: null });
    expect(account[0]!.createdAt).toEqual(expect.any(String));
    expect(account[0]!.updatedAt).toEqual(expect.any(String));

    const todoLines = of('todo');
    expect(todoLines).toHaveLength(2);
    expect(todoLines.map((t) => t.title)).toEqual(['still here', 'in the trash']);
    // F-010's trash is still held, so it is still exported — with deletedAt set.
    expect(todoLines[0]!.deletedAt).toBeNull();
    expect(todoLines[1]!.deletedAt).toEqual(expect.any(String));
    expect(todoLines[1]!.id).toBe(trashedId);

    const sessionLines = of('session');
    expect(sessionLines).toHaveLength(1);
    expect(Object.keys(sessionLines[0]!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'type',
      'userAgent',
    ]);

    const auditLines = of('audit_event');
    expect(auditLines.length).toBeGreaterThanOrEqual(1);
    expect(auditLines.map((a) => a.action)).toContain('auth.register');

    const end = lines.at(-1) as EndLine;
    expect(end.counts).toEqual({
      todos: todoLines.length,
      sessions: sessionLines.length,
      auditEvents: auditLines.length,
    });
  });

  it('the export refuses credentials and the refused tables', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'refused-export@example.com');

    // A row in each of the three refused tables, so "absent" means refused
    // rather than "there was nothing to leak".
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/auth/password-reset',
          payload: { email: user.email },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/auth/verify-email',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(202);
    const idempotencyKey = 'export-refusal-key-0001';
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/todos',
          headers: { cookie, 'idempotency-key': idempotencyKey },
          payload: { title: 'idempotent todo' },
        })
      ).statusCode,
    ).toBe(201);

    const stored = await ctx.db.execute<{
      password_hash: string;
      reset_hash: string;
      verify_hash: string;
      fingerprint: string;
    }>(sql`
      SELECT u.password_hash,
             p.token_hash AS reset_hash,
             v.token_hash AS verify_hash,
             i.fingerprint
        FROM users u
        JOIN password_reset_tokens p ON p.user_id = u.id
        JOIN email_verification_tokens v ON v.user_id = u.id
        JOIN idempotency_keys i ON i.user_id = u.id
       WHERE u.id = ${user.id}`);
    expect(stored.rows).toHaveLength(1);
    const secrets = stored.rows[0]!;

    const captured = captureSql(ctx.pool);
    let body: string;
    try {
      const res = await exportRaw(cookie);
      expect(res.statusCode).toBe(200);
      body = res.body;
    } finally {
      captured.restore();
    }

    // Asserted against the raw serialised body: an undeclared key survives
    // JSON.parse just as happily as it survives a reviewer.
    for (const forbidden of [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'fingerprint',
      'responseBody',
      'response_body',
      secrets.password_hash,
      secrets.reset_hash,
      secrets.verify_hash,
      secrets.fingerprint,
      idempotencyKey,
      // sha256(token) for the caller's own live session (ADR 0014).
      hashSessionToken(tokenOf(cookie)),
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // Not merely absent from the document: never read at all.
    const touched = captured.statements.join('\n').toLowerCase();
    for (const table of [
      'password_reset_tokens',
      'email_verification_tokens',
      'idempotency_keys',
    ]) {
      expect(touched).not.toContain(table);
    }
    // The capture really did see the export's own statements.
    expect(touched).toContain('from "todos"');
    expect(touched).toContain('from "audit_events"');
  });

  it('the export never crosses accounts', async () => {
    const alice = await registerUser(ctx.app, 'alice-export@example.com');
    const bob = await registerUser(ctx.app, 'bob-export@example.com');

    await seedTodos(alice.user.id, 3, 'alice-secret-todo');
    await seedTodos(bob.user.id, 1, 'bob-todo');
    const aliceRows = await ctx.db.execute<{ id: string; title: string }>(
      sql`SELECT id::text, title FROM todos WHERE user_id = ${alice.user.id}`,
    );
    const aliceSessions = await ctx.db.execute<{ public_id: string }>(
      sql`SELECT public_id::text FROM sessions WHERE user_id = ${alice.user.id}`,
    );
    const aliceEvents = await ctx.db.execute<{ id: string }>(
      sql`SELECT id::text FROM audit_events WHERE user_id = ${alice.user.id}`,
    );
    expect(aliceRows.rows.length).toBe(3);
    expect(aliceSessions.rows.length).toBe(1);
    expect(aliceEvents.rows.length).toBeGreaterThan(0);

    const { res, of } = await exported(bob.cookie);

    expect(of('todo').map((t) => t.title)).toEqual(['bob-todo-0']);
    expect(of('account')[0]).toMatchObject({ id: bob.user.id, email: bob.user.email });
    for (const row of aliceRows.rows) {
      expect(res.body).not.toContain(row.id);
      expect(res.body).not.toContain(row.title);
    }
    for (const row of aliceSessions.rows) expect(res.body).not.toContain(row.public_id);
    for (const row of aliceEvents.rows) expect(res.body).not.toContain(row.id);
    expect(res.body).not.toContain(alice.user.email);
    expect(res.body).not.toContain(alice.user.id);
  });

  it('an empty account still exports a valid document', async () => {
    const { cookie } = await registerUser(ctx.app, 'empty-export@example.com');

    const { res, lines, of } = await exported(cookie);

    expect(res.statusCode).toBe(200);
    expect(of('todo')).toHaveLength(0);
    expect(of('account')).toHaveLength(1);
    const end = lines.at(-1) as EndLine;
    expect(end.type).toBe('end');
    expect(end.counts.todos).toBe(0);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('the export pages across batch boundaries without gaps or duplicates', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'batched-export@example.com');
    await seedTodos(user.id, EXPORT_BATCH_SIZE + 1, 'paged');

    const { lines, of } = await exported(cookie);

    const todoLines = of('todo');
    expect(todoLines).toHaveLength(EXPORT_BATCH_SIZE + 1);
    // Every row exactly once, including across the boundary at 500/501.
    expect(new Set(todoLines.map((t) => t.id as string)).size).toBe(EXPORT_BATCH_SIZE + 1);
    expect(todoLines.map((t) => t.title)).toEqual(
      Array.from({ length: EXPORT_BATCH_SIZE + 1 }, (_, i) => `paged-${i}`),
    );
    // Oldest first, which is the direction the supporting index scans.
    const created = todoLines.map((t) => Date.parse(t.createdAt as string));
    expect(created).toEqual([...created].sort((a, b) => a - b));
    expect((lines.at(-1) as EndLine).counts.todos).toBe(EXPORT_BATCH_SIZE + 1);
  });

  it('the session and audit sections page across a boundary too', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'batched-rest@example.com');
    // The three sections share one keyset loop but not one cursor column: these
    // two page on a uuid tie-break rather than the todo id, which nothing else
    // in the suite exercises because it only matters past 500 rows.
    await ctx.db.execute(sql`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      SELECT md5('session-' || g::text), ${user.id}, now() + interval '1 day',
             now() - make_interval(secs => g)
        FROM generate_series(1, ${EXPORT_BATCH_SIZE}) g`);
    await ctx.db.execute(sql`
      INSERT INTO audit_events (user_id, action, outcome, created_at)
      SELECT ${user.id}, 'auth.login', 'success', now() - make_interval(secs => g)
        FROM generate_series(1, ${EXPORT_BATCH_SIZE}) g`);

    const { lines, of } = await exported(cookie);

    // The seeded rows plus the ones registration produced, each exactly once.
    const sessionLines = of('session');
    const auditLines = of('audit_event');
    expect(sessionLines).toHaveLength(EXPORT_BATCH_SIZE + 1);
    expect(auditLines.length).toBeGreaterThan(EXPORT_BATCH_SIZE);
    expect(new Set(sessionLines.map((s) => s.id as string)).size).toBe(sessionLines.length);
    expect(new Set(auditLines.map((a) => a.id as string)).size).toBe(auditLines.length);

    for (const section of [sessionLines, auditLines]) {
      const created = section.map((l) => Date.parse(l.createdAt as string));
      expect(created).toEqual([...created].sort((a, b) => a - b));
    }
    const end = lines.at(-1) as EndLine;
    expect(end.counts.sessions).toBe(sessionLines.length);
    expect(end.counts.auditEvents).toBe(auditLines.length);
  });

  it('the export requires authentication', async () => {
    const { user } = await registerUser(ctx.app, 'anon-export@example.com');
    await seedTodos(user.id, 1, 'private-title');

    const res = await exportRaw();

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    expect(res.body).not.toContain('"type":"export"');
    expect(res.body).not.toContain('private-title');
    expect(res.body).not.toContain(user.email);
  });

  it('the export budget is five per hour and per account', async () => {
    const heavy = await registerUser(ctx.app, 'budget-export@example.com');
    const bystander = await registerUser(ctx.app, 'budget-bystander@example.com');

    for (let i = 0; i < EXPORT_RATE_LIMIT_MAX; i++) {
      expect((await exportRaw(heavy.cookie)).statusCode).toBe(200);
    }

    const refused = await exportRaw(heavy.cookie);
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    expect(refused.body).not.toContain('"type":"export"');
    expect(refused.body).not.toContain(heavy.user.email);

    // Per account, not per instance: another account's first export is fine.
    expect((await exportRaw(bystander.cookie)).statusCode).toBe(200);
  });
});

describe('the audit trail of an export', () => {
  it('an export is recorded in the audit trail', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'audited-export@example.com');
    const bystander = await registerUser(ctx.app, 'audited-bystander@example.com');
    await ctx.db.execute(sql`DELETE FROM audit_events`);

    expect((await exportRaw(cookie)).statusCode).toBe(200);

    const rows = await ctx.db
      .select({
        userId: auditEvents.userId,
        action: auditEvents.action,
        outcome: auditEvents.outcome,
      })
      .from(auditEvents);
    expect(rows).toEqual([{ userId: user.id, action: 'account.exported', outcome: 'success' }]);

    // Visible to the account it happened to, and to nobody else.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/audit-events',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toContain(
      'account.exported',
    );
    const others = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/audit-events',
      headers: { cookie: bystander.cookie },
    });
    expect(others.json<{ items: { action: string }[] }>().items).toHaveLength(0);
  });

  it('an unwritable audit table does not deny a user their data', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'unwritable-export@example.com');
    await seedTodos(user.id, 2, 'still-mine');
    const before = counterValue(await readMetrics(), 'audit_write_failures_total');

    // Inserts fail, reads still work: the export must lose its own audit row
    // and nothing else. A renamed table would break the read as well.
    await ctx.db.execute(sql`
      CREATE OR REPLACE FUNCTION test_block_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit table is unwritable'; END $$`);
    await ctx.db.execute(sql`
      CREATE TRIGGER test_block_audit_insert BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_block_audit_insert()`);

    try {
      const { res, lines, of } = await exported(cookie);
      expect(res.statusCode).toBe(200);
      expect(of('todo')).toHaveLength(2);
      // Complete: the terminator is there, so the document is not truncated.
      expect(lines.at(-1)!.type).toBe('end');
    } finally {
      await ctx.db.execute(sql`DROP TRIGGER test_block_audit_insert ON audit_events`);
      await ctx.db.execute(sql`DROP FUNCTION test_block_audit_insert()`);
    }

    const after = counterValue(await readMetrics(), 'audit_write_failures_total');
    expect(after).toBe(before + 1);
  });
});

describe('a batch failure after the first byte', () => {
  it('ends the document without a terminator and never counts it completed', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'truncated-export@example.com');
    await seedTodos(user.id, 3, 'before-the-failure');

    const before = await readMetrics();
    const startedBefore = counterValue(before, 'account_exports_total', { outcome: 'started' });
    const completedBefore = counterValue(before, 'account_exports_total', { outcome: 'completed' });
    const failedBefore = counterValue(before, 'account_exports_total', { outcome: 'failed' });

    // Over a real socket rather than app.inject(): a truncated chunked
    // response is exactly what a client sees, and inject() collapses it into
    // one rejected promise with no partial body to look at.
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (ctx.app.server.address() as { port: number }).port;

    // The audit_events section is the last one, so every earlier section has
    // already been written to the socket when this makes the batch query fail.
    await ctx.db.execute(sql`ALTER TABLE audit_events RENAME TO audit_events_hidden`);
    let result: { status: number; body: string; aborted: boolean };
    try {
      result = await new Promise((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/auth/export', headers: { cookie } },
          (res) => {
            let body = '';
            let aborted = false;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('aborted', () => (aborted = true));
            res.on('error', () => (aborted = true));
            res.on('close', () => resolve({ status: res.statusCode!, body, aborted }));
          },
        );
        req.on('error', reject);
      });
    } finally {
      await ctx.db.execute(sql`ALTER TABLE audit_events_hidden RENAME TO audit_events`);
    }

    // The status line was already 200 before anything could go wrong, which is
    // the whole reason the terminator exists (ADR 0026).
    expect(result.status).toBe(200);
    expect(result.aborted).toBe(true);
    expect(result.body).toContain('"type":"export"');
    expect(result.body).toContain('before-the-failure-0');
    // The one signal a client has that this document must be discarded.
    expect(result.body).not.toContain('"type":"end"');

    const after = await readMetrics();
    expect(counterValue(after, 'account_exports_total', { outcome: 'started' })).toBe(
      startedBefore + 1,
    );
    expect(counterValue(after, 'account_exports_total', { outcome: 'completed' })).toBe(
      completedBefore,
    );
    expect(counterValue(after, 'account_exports_total', { outcome: 'failed' })).toBe(
      failedBefore + 1,
    );
  });
});

describe('operational surface', () => {
  it('exposes export counters', async () => {
    const { cookie } = await registerUser(ctx.app, 'counters-export@example.com');
    const before = await readMetrics();
    const startedBefore = counterValue(before, 'account_exports_total', { outcome: 'started' });
    const completedBefore = counterValue(before, 'account_exports_total', { outcome: 'completed' });
    const auditBefore = counterValue(before, 'audit_events_total', {
      action: 'account.exported',
      outcome: 'success',
    });

    expect((await exportRaw(cookie)).statusCode).toBe(200);

    const after = await readMetrics();
    expect(after).toContain('account_exports_total');
    expect(after).toContain('account_export_duration_seconds');
    expect(counterValue(after, 'account_exports_total', { outcome: 'started' })).toBe(
      startedBefore + 1,
    );
    expect(counterValue(after, 'account_exports_total', { outcome: 'completed' })).toBe(
      completedBefore + 1,
    );
    expect(
      counterValue(after, 'audit_events_total', {
        action: 'account.exported',
        outcome: 'success',
      }),
    ).toBe(auditBefore + 1);
    expect(counterValue(after, 'account_export_duration_seconds_count')).toBe(completedBefore + 1);
  });

  it('the export logs no identifiers and no content', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const logged = await createTestContext({ LOG_LEVEL: 'trace' }, { logStream });
    try {
      await resetDb(logged.db);
      const email = 'logscan-export@example.com';
      const agent = 'SuperSecretBrowser/1.0';
      const title = 'a-title-that-must-not-be-logged';
      const { cookie, user } = await registerUser(logged.app, email);
      await logged.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: PASSWORD },
        headers: { 'user-agent': agent },
      });
      await logged.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie },
        payload: { title },
      });

      const res = await logged.app.inject({
        method: 'GET',
        url: '/api/auth/export',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(title);

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0);
      // The one handler that has every sensitive value in the application in
      // local variables at once, and it logs counts and a duration.
      expect(output).toContain('account exported');
      expect(output).not.toContain(email);
      expect(output).not.toContain(agent);
      expect(output).not.toContain(title);
      expect(output).not.toContain(user.id);
      expect(output).not.toContain(tokenOf(cookie));
      expect(output).not.toContain(hashSessionToken(tokenOf(cookie)));
      const publicIds = await logged.db.execute<{ public_id: string }>(
        sql`SELECT public_id FROM sessions`,
      );
      for (const row of publicIds.rows) expect(output).not.toContain(row.public_id);
    } finally {
      await logged.close();
    }
  });
});
