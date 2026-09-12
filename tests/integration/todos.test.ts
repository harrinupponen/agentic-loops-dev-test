import { eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todos } from '../../src/db/schema.js';
import {
  createTestContext,
  metricsAuth,
  registerUser,
  resetDb,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  // Every case registers its own account and the limiter keys on the IP;
  // the same allowance sessions.test.ts and idempotency.test.ts take.
  ctx = await createTestContext({ AUTH_RATE_LIMIT_MAX: '10000' });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
});

async function createTodo(cookie: string, title: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/todos',
    headers: { cookie },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; title: string; completed: boolean }>();
}

describe('todos', () => {
  it('requires authentication for every endpoint', async () => {
    for (const [method, url] of [
      ['GET', '/api/todos'],
      ['POST', '/api/todos'],
      ['GET', '/api/todos/00000000-0000-0000-0000-000000000000'],
      ['PATCH', '/api/todos/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/todos/00000000-0000-0000-0000-000000000000'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, reads, updates and deletes a todo', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'write the harness');

    const read = await ctx.app.inject({ url: `/api/todos/${todo.id}`, headers: { cookie } });
    expect(read.json()).toMatchObject({ id: todo.id, title: 'write the harness' });

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    expect(patched.json()).toMatchObject({ completed: true });

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    const gone = await ctx.app.inject({ url: `/api/todos/${todo.id}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });

  it("never leaks another user's todo", async () => {
    const alice = await registerUser(ctx.app, 'alice@example.com');
    const bob = await registerUser(ctx.app, 'bob@example.com');
    const secret = await createTodo(alice.cookie, 'alice private note');

    const read = await ctx.app.inject({
      url: `/api/todos/${secret.id}`,
      headers: { cookie: bob.cookie },
    });
    // 404, not 403 — Bob must not learn that this id exists.
    expect(read.statusCode).toBe(404);

    const list = await ctx.app.inject({ url: '/api/todos', headers: { cookie: bob.cookie } });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('paginates with a stable keyset cursor', async () => {
    const { cookie } = await registerUser(ctx.app);
    for (let i = 0; i < 5; i++) {
      await createTodo(cookie, `todo ${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }

    const first = await ctx.app.inject({ url: '/api/todos?limit=2', headers: { cookie } });
    const page1 = first.json<{ items: { title: string }[]; nextCursor: string | null }>();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await ctx.app.inject({
      url: `/api/todos?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: { cookie },
    });
    const page2 = second.json<{ items: { title: string }[] }>();
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((t) => t.title)).not.toEqual(page1.items.map((t) => t.title));
  });

  it('a serialised nextCursor round-trips as a query parameter', async () => {
    const { cookie } = await registerUser(ctx.app);
    for (let i = 0; i < 21; i++) {
      await createTodo(cookie, `todo ${i}`);
      // The cursor is serialised to millisecond precision; spacing the rows
      // keeps this test about the round trip and not about clock resolution.
      await new Promise((r) => setTimeout(r, 2));
    }

    // Exactly the query string web/src/todos.ts builds for the first page.
    const first = await ctx.app.inject({ url: '/api/todos?limit=20', headers: { cookie } });
    const page1 = first.json<{ items: { title: string }[]; nextCursor: string | null }>();
    expect(page1.items).toHaveLength(20);
    expect(typeof page1.nextCursor).toBe('string');

    // The client treats nextCursor as opaque: it echoes the string the API
    // serialised, percent-encoded, and never parses or recomputes it.
    const second = await ctx.app.inject({
      url: `/api/todos?limit=20&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: { cookie },
    });
    const page2 = second.json<{ items: { title: string }[]; nextCursor: string | null }>();

    expect(second.statusCode).toBe(200);
    expect(page2.items.map((t) => t.title)).toEqual(['todo 0']);
    expect(page2.nextCursor).toBeNull();
    // No row is skipped and none is served twice across the two pages.
    expect(new Set([...page1.items, ...page2.items].map((t) => t.title)).size).toBe(21);
  });

  it('rejects an empty patch body', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'unchanged');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized title', async () => {
    const { cookie } = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });
});

// --- F-010 soft delete -------------------------------------------------------

interface TodoView {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const softDelete = (cookie: string, id: string) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/todos/${id}`, headers: { cookie } });

const restore = (id: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/todos/${id}/restore`, headers });

const restoreAs = (cookie: string, id: string) => restore(id, { cookie });

const listTodos = async (cookie: string, query = '') => {
  const res = await ctx.app.inject({ url: `/api/todos${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<{ items: TodoView[]; nextCursor: string | null }>();
};

/** Reads the row straight from the database, bypassing every route predicate. */
const rowOf = async (id: string) => {
  const rows = await ctx.db.select().from(todos).where(eq(todos.id, id));
  return rows[0];
};

/** Backdates a soft delete, which is the only way to reach the retention window. */
const backdateDeletion = (id: string, days: number) =>
  ctx.db.execute(
    sql`UPDATE todos SET deleted_at = now() - make_interval(days => ${days}) WHERE id = ${id}`,
  );

describe('todos · soft delete', () => {
  it('delete hides the todo without removing the row', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'recoverable');

    const res = await softDelete(cookie, todo.id);
    expect(res.statusCode).toBe(204);

    const row = await rowOf(todo.id);
    expect(row).toBeDefined();
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(row!.title).toBe('recoverable');

    const read = await ctx.app.inject({ url: `/api/todos/${todo.id}`, headers: { cookie } });
    expect(read.statusCode).toBe(404);
  });

  it('deleted todos are excluded from the default list', async () => {
    const { cookie } = await registerUser(ctx.app);
    const first = await createTodo(cookie, 'before');
    const middle = await createTodo(cookie, 'middle');
    const last = await createTodo(cookie, 'after');

    expect((await softDelete(cookie, middle.id)).statusCode).toBe(204);

    const { items } = await listTodos(cookie);
    expect(items.map((t) => t.id).sort()).toEqual([first.id, last.id].sort());
    expect(items.map((t) => t.title)).not.toContain('middle');
    // Hidden from the list, not removed: the row is still there to restore.
    expect((await rowOf(middle.id))!.deletedAt).not.toBeNull();
  });

  it('a deleted todo cannot be edited', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'original title');
    expect((await softDelete(cookie, todo.id)).statusCode).toBe(204);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${todo.id}`,
      headers: { cookie },
      payload: { title: 'edited after deletion', completed: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');

    const row = await rowOf(todo.id);
    expect(row!.title).toBe('original title');
    expect(row!.completed).toBe(false);
  });

  it('deleting twice is a 404', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'delete me twice');
    expect((await softDelete(cookie, todo.id)).statusCode).toBe(204);
    const first = (await rowOf(todo.id))!.deletedAt;

    const second = await softDelete(cookie, todo.id);
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('not_found');
    // The stamp records the first deletion; a retry must not move it.
    expect((await rowOf(todo.id))!.deletedAt).toEqual(first);
  });

  it('restore brings the todo back in place', async () => {
    const { cookie } = await registerUser(ctx.app);
    const created = await createTodo(cookie, 'undo me');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${created.id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    const before = (
      await ctx.app.inject({
        url: `/api/todos/${created.id}`,
        headers: { cookie },
      })
    ).json<TodoView>();

    expect((await softDelete(cookie, created.id)).statusCode).toBe(204);

    const res = await restoreAs(cookie, created.id);
    expect(res.statusCode).toBe(200);
    const restored = res.json<TodoView>();
    expect(restored.id).toBe(before.id);
    expect(restored.title).toBe(before.title);
    expect(restored.completed).toBe(before.completed);
    expect(restored.createdAt).toBe(before.createdAt);
    expect(restored.deletedAt).toBeNull();

    const read = await ctx.app.inject({ url: `/api/todos/${created.id}`, headers: { cookie } });
    expect(read.statusCode).toBe(200);
    const { items } = await listTodos(cookie);
    expect(items.map((t) => t.id)).toContain(created.id);
  });

  it('restore is idempotent', async () => {
    const { cookie } = await registerUser(ctx.app);
    const deleted = await createTodo(cookie, 'restored twice');
    const live = await createTodo(cookie, 'never deleted');

    expect((await softDelete(cookie, deleted.id)).statusCode).toBe(204);
    const first = await restoreAs(cookie, deleted.id);
    const second = await restoreAs(cookie, deleted.id);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<TodoView>().deletedAt).toBeNull();
    expect(second.json<TodoView>().id).toBe(deleted.id);

    // Restoring something that was never deleted is a success, not a conflict.
    const untouched = await ctx.app.inject({ url: `/api/todos/${live.id}`, headers: { cookie } });
    const never = await restoreAs(cookie, live.id);
    expect(never.statusCode).toBe(200);
    expect(never.json<TodoView>().deletedAt).toBeNull();
    expect(never.json<TodoView>().title).toBe('never deleted');
    // The documented cost of carrying no `deleted_at` predicate on restore:
    // updated_at moves. Asserted rather than hidden.
    expect(new Date(never.json<TodoView>().updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(untouched.json<TodoView>().updatedAt).getTime(),
    );
  });

  it('the trash listing returns only deleted todos', async () => {
    const { cookie } = await registerUser(ctx.app);
    const live = await createTodo(cookie, 'still here');
    const gone = await createTodo(cookie, 'in the trash');
    expect((await softDelete(cookie, gone.id)).statusCode).toBe(204);

    const trash = await listTodos(cookie, '?deleted=true');
    expect(trash.items.map((t) => t.id)).toEqual([gone.id]);
    expect(trash.items[0]!.deletedAt).not.toBeNull();

    const explicit = await listTodos(cookie, '?deleted=false');
    const implicit = await listTodos(cookie);
    expect(explicit.items.map((t) => t.id)).toEqual([live.id]);
    expect(explicit).toEqual(implicit);

    const invalid = await ctx.app.inject({ url: '/api/todos?deleted=maybe', headers: { cookie } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('the trash listing paginates by keyset', async () => {
    const { cookie } = await registerUser(ctx.app);
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      created.push((await createTodo(cookie, `trash ${i}`)).id);
      await new Promise((r) => setTimeout(r, 2));
    }
    for (const id of created) expect((await softDelete(cookie, id)).statusCode).toBe(204);

    const page1 = await listTodos(cookie, '?deleted=true&limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listTodos(
      cookie,
      `?deleted=true&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((t) => t.id)).size).toBe(3);
  });

  it('deleting a row mid-scroll does not skip its neighbours', async () => {
    const { cookie } = await registerUser(ctx.app);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await createTodo(cookie, `todo ${i}`)).id);
      await new Promise((r) => setTimeout(r, 2));
    }

    // Newest first: page 1 is todo 4 and todo 3, so todo 2 starts page 2.
    const page1 = await listTodos(cookie, '?limit=2');
    expect(page1.items.map((t) => t.title)).toEqual(['todo 4', 'todo 3']);
    expect((await softDelete(cookie, ids[2]!)).statusCode).toBe(204);

    const seen = [...page1.items.map((t) => t.title)];
    let cursor = page1.nextCursor;
    while (cursor) {
      const page = await listTodos(cookie, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...page.items.map((t) => t.title));
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(['todo 4', 'todo 3', 'todo 1', 'todo 0']);
    expect(new Set(seen).size).toBe(seen.length);
    // The skipped row is in the trash, not gone.
    const trash = await listTodos(cookie, '?deleted=true');
    expect(trash.items.map((t) => t.id)).toEqual([ids[2]]);
  });

  it('TodoView always carries deletedAt', async () => {
    const { cookie } = await registerUser(ctx.app);
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { cookie },
      payload: { title: 'shape check' },
    });
    expect(create.json<TodoView>().deletedAt).toBeNull();
    const id = create.json<TodoView>().id;

    const read = await ctx.app.inject({ url: `/api/todos/${id}`, headers: { cookie } });
    expect(read.json<TodoView>().deletedAt).toBeNull();

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/todos/${id}`,
      headers: { cookie },
      payload: { completed: true },
    });
    expect(patched.json<TodoView>().deletedAt).toBeNull();

    const { items } = await listTodos(cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty('deletedAt', null);
  });

  it("another user's todo can be neither deleted nor restored", async () => {
    const alice = await registerUser(ctx.app, 'alice-soft@example.com');
    const bob = await registerUser(ctx.app, 'bob-soft@example.com');
    const live = await createTodo(alice.cookie, 'alice live note');
    const trashed = await createTodo(alice.cookie, 'alice deleted note');
    expect((await softDelete(alice.cookie, trashed.id)).statusCode).toBe(204);
    const stamp = (await rowOf(trashed.id))!.deletedAt;

    const bobDeletes = await softDelete(bob.cookie, live.id);
    expect(bobDeletes.statusCode).toBe(404);
    expect((await rowOf(live.id))!.deletedAt).toBeNull();

    const bobRestores = await restoreAs(bob.cookie, trashed.id);
    expect(bobRestores.statusCode).toBe(404);
    expect(bobRestores.json<{ error: { code: string } }>().error.code).toBe('not_found');
    expect((await rowOf(trashed.id))!.deletedAt).toEqual(stamp);

    const bobTrash = await listTodos(bob.cookie, '?deleted=true');
    expect(bobTrash.items).toHaveLength(0);
  });

  it('restore requires authentication and a valid id', async () => {
    const { cookie } = await registerUser(ctx.app);
    const todo = await createTodo(cookie, 'guarded');
    expect((await softDelete(cookie, todo.id)).statusCode).toBe(204);

    const anonymous = await restore(todo.id);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    // Rejected before anything was touched.
    expect((await rowOf(todo.id))!.deletedAt).not.toBeNull();

    const malformed = await restoreAs(cookie, 'not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('the retention sweep purges rows past the window and nothing else', async () => {
    const { cookie } = await registerUser(ctx.app);
    const expired = await createTodo(cookie, 'deleted 31 days ago');
    const recent = await createTodo(cookie, 'deleted 29 days ago');
    const live = await createTodo(cookie, 'still live');
    const trigger = await createTodo(cookie, 'deleted now');

    for (const id of [expired.id, recent.id]) {
      expect((await softDelete(cookie, id)).statusCode).toBe(204);
    }
    await backdateDeletion(expired.id, 31);
    await backdateDeletion(recent.id, 29);

    expect((await softDelete(cookie, trigger.id)).statusCode).toBe(204);

    expect(await rowOf(expired.id)).toBeUndefined();
    expect(await rowOf(recent.id)).toBeDefined();
    expect(await rowOf(live.id)).toBeDefined();
    expect(await rowOf(trigger.id)).toBeDefined();
  });

  it('the retention sweep is scoped to the caller', async () => {
    const alice = await registerUser(ctx.app, 'alice-sweep@example.com');
    const bob = await registerUser(ctx.app, 'bob-sweep@example.com');
    const aliceExpired = await createTodo(alice.cookie, 'alice old trash');
    const bobExpired = await createTodo(bob.cookie, 'bob old trash');
    const trigger = await createTodo(alice.cookie, 'alice fresh delete');

    expect((await softDelete(alice.cookie, aliceExpired.id)).statusCode).toBe(204);
    expect((await softDelete(bob.cookie, bobExpired.id)).statusCode).toBe(204);
    await backdateDeletion(aliceExpired.id, 31);
    await backdateDeletion(bobExpired.id, 31);

    expect((await softDelete(alice.cookie, trigger.id)).statusCode).toBe(204);

    expect(await rowOf(aliceExpired.id)).toBeUndefined();
    expect(await rowOf(bobExpired.id)).toBeDefined();
  });

  it('exposes soft delete counters', async () => {
    const { cookie } = await registerUser(ctx.app, 'softdelete-counters@example.com');
    const expired = await createTodo(cookie, 'expired');
    const trigger = await createTodo(cookie, 'trigger');
    const restorable = await createTodo(cookie, 'restorable');

    expect((await softDelete(cookie, expired.id)).statusCode).toBe(204);
    await backdateDeletion(expired.id, 31);

    const read = async () => {
      const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
      const value = (action: string) =>
        Number(
          new RegExp(`todos_soft_delete_total\\{action="${action}"\\}\\s+(\\d+)`).exec(
            res.body,
          )?.[1] ?? 0,
        );
      return {
        body: res.body,
        deleted: value('deleted'),
        restored: value('restored'),
        purged: value('purged'),
      };
    };

    const before = await read();
    expect((await softDelete(cookie, trigger.id)).statusCode).toBe(204);
    expect((await softDelete(cookie, restorable.id)).statusCode).toBe(204);
    expect((await restoreAs(cookie, restorable.id)).statusCode).toBe(200);
    const after = await read();

    expect(after.body).toContain('todos_soft_delete_total');
    expect(after.deleted).toBe(before.deleted + 2);
    expect(after.restored).toBe(before.restored + 1);
    // Advances by rows actually removed: exactly the one backdated row.
    expect(after.purged).toBe(before.purged + 1);
  });

  it('todo titles are never logged', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const logged = await createTestContext(
      { LOG_LEVEL: 'trace', AUTH_RATE_LIMIT_MAX: '10000' },
      { logStream },
    );
    try {
      await resetDb(logged.db);
      const { cookie } = await registerUser(logged.app, 'logscan-todos@example.com');
      const title = 'SuperSecretTodoTitle';
      const created = await logged.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie },
        payload: { title },
      });
      const id = created.json<TodoView>().id;

      for (const call of [
        { method: 'DELETE' as const, url: `/api/todos/${id}` },
        { method: 'POST' as const, url: `/api/todos/${id}/restore` },
        { method: 'DELETE' as const, url: `/api/todos/${id}` },
      ]) {
        await logged.app.inject({ ...call, headers: { cookie } });
      }

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      expect(output).not.toContain(title);
    } finally {
      await logged.close();
    }
  });
});
