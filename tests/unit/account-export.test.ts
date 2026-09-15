import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import {
  accountLine,
  auditEventLine,
  encodeLine,
  EXPORTED_TABLES,
  EXPORT_BATCH_SIZE,
  EXPORT_FORMAT,
  REFUSED_TABLES,
  sessionLine,
  todoLine,
} from '../../src/routes/account.js';

/**
 * Complete database rows, typed as the schema's own inferred selects. Two
 * things follow from that and both are the point of this file: the fixtures
 * carry every column the table has — including `passwordHash` and the session
 * token hash — and a migration that renames or drops a column breaks this file
 * at compile time rather than quietly shipping a mapper that reads undefined.
 */
const userRow: typeof schema.users.$inferSelect = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'mapper@example.com',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
  emailVerifiedAt: new Date('2026-01-02T03:04:05.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-03T00:00:00.000Z'),
};

const todoRow: typeof schema.todos.$inferSelect = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: userRow.id,
  title: 'buy milk',
  completed: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: new Date('2026-01-03T00:00:00.000Z'),
};

const sessionRow: typeof schema.sessions.$inferSelect = {
  // sha256(token): a verifier for a live credential, and the single value this
  // file exists to keep out of an export (ADR 0014, ADR 0027).
  id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  publicId: '33333333-3333-4333-8333-333333333333',
  userId: userRow.id,
  userAgent: 'SecretBrowser/1.0',
  expiresAt: new Date('2026-02-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const auditRow: typeof schema.auditEvents.$inferSelect = {
  id: '44444444-4444-4444-8444-444444444444',
  userId: userRow.id,
  action: 'auth.login',
  outcome: 'success',
  createdAt: new Date('2026-01-04T00:00:00.000Z'),
};

describe('the export mappers emit only allowlisted keys', () => {
  it('an account line carries no password hash', () => {
    const line = accountLine(userRow);

    expect(Object.keys(line).sort()).toEqual([
      'createdAt',
      'email',
      'emailVerifiedAt',
      'id',
      'type',
      'updatedAt',
    ]);
    expect(line).toEqual({
      type: 'account',
      id: userRow.id,
      email: userRow.email,
      // The stored timestamp, not F-002's derived boolean: an export reports
      // what is stored, not what an API view shows.
      emailVerifiedAt: '2026-01-02T03:04:05.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(JSON.stringify(line)).not.toContain(userRow.passwordHash);
  });

  it('an unverified account exports a null timestamp rather than omitting it', () => {
    const line = accountLine({ ...userRow, emailVerifiedAt: null });
    expect(line.emailVerifiedAt).toBeNull();
    expect(Object.keys(line)).toContain('emailVerifiedAt');
  });

  it('a todo line carries the owner nowhere and the deletion everywhere', () => {
    const line = todoLine(todoRow);

    expect(Object.keys(line).sort()).toEqual([
      'completed',
      'createdAt',
      'deletedAt',
      'id',
      'title',
      'type',
      'updatedAt',
    ]);
    expect(line).toEqual({
      type: 'todo',
      id: todoRow.id,
      title: 'buy milk',
      completed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      deletedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(JSON.stringify(line)).not.toContain(todoRow.userId);
    expect(todoLine({ ...todoRow, deletedAt: null }).deletedAt).toBeNull();
  });

  it('a session line carries the public id and never the token hash', () => {
    const line = sessionLine(sessionRow);

    expect(Object.keys(line).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'type', 'userAgent']);
    expect(line).toEqual({
      type: 'session',
      // `public_id`, exactly as F-009's list does.
      id: sessionRow.publicId,
      userAgent: 'SecretBrowser/1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
    });
    expect(JSON.stringify(line)).not.toContain(sessionRow.id);
    expect(sessionLine({ ...sessionRow, userAgent: null }).userAgent).toBeNull();
  });

  it('an audit event line carries four columns and no owner', () => {
    const line = auditEventLine(auditRow);

    expect(Object.keys(line).sort()).toEqual(['action', 'createdAt', 'id', 'outcome', 'type']);
    expect(line).toEqual({
      type: 'audit_event',
      id: auditRow.id,
      action: 'auth.login',
      outcome: 'success',
      createdAt: '2026-01-04T00:00:00.000Z',
    });
    expect(JSON.stringify(line)).not.toContain(auditRow.userId);
  });
});

describe('the line encoder', () => {
  it('ends every line in a newline and escapes the ones inside content', () => {
    const line = encodeLine(todoLine({ ...todoRow, title: 'first\nsecond "quoted"\r\n' }));

    // Exactly one newline, and it is the terminator of the line itself: a
    // title that contains one must not become two lines of the document.
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(line.slice(0, -1)).not.toContain('\r');
    expect((JSON.parse(line) as { title: string }).title).toBe('first\nsecond "quoted"\r\n');
  });

  it('encodes the header and the terminator as single lines', () => {
    const header = encodeLine({ type: 'export', format: EXPORT_FORMAT, exportedAt: 'now' });
    const end = encodeLine({ type: 'end', counts: { todos: 1, sessions: 2, auditEvents: 3 } });

    expect(header.split('\n')).toHaveLength(2);
    expect(end.split('\n')).toHaveLength(2);
    expect(JSON.parse(header)).toMatchObject({ format: 'agentic-todo.export.v1' });
  });
});

describe('the allowlist is exhaustive', () => {
  /** Every table declared in src/db/schema.ts, by its database name. */
  const declared = Object.values(schema as Record<string, unknown>)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table));

  it('every table in the schema is either exported or refused, by name', () => {
    const decided = [...EXPORTED_TABLES, ...Object.keys(REFUSED_TABLES)].sort();

    // ADR 0027's rule, made mechanical: a migration that adds a table has to
    // come back here and say whether the export contains it. A table with no
    // verdict is an unfinished export, and this is where that is noticed —
    // not in a subject access request.
    expect([...declared].sort()).toEqual(decided);
  });

  it('names no table twice and refuses every credential store', () => {
    const decided = [...EXPORTED_TABLES, ...Object.keys(REFUSED_TABLES)];
    expect(new Set(decided).size).toBe(decided.length);

    expect(EXPORTED_TABLES).toEqual(['users', 'todos', 'sessions', 'audit_events']);
    expect(Object.keys(REFUSED_TABLES).sort()).toEqual([
      'email_verification_tokens',
      'idempotency_keys',
      'password_reset_tokens',
    ]);
    // Every refusal carries its reason in the module, not just in the spec.
    for (const reason of Object.values(REFUSED_TABLES)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the batch size', () => {
  it('is a constant the stream pages by, not configuration', () => {
    expect(EXPORT_BATCH_SIZE).toBe(500);
    expect(Number.isInteger(EXPORT_BATCH_SIZE)).toBe(true);
  });
});
