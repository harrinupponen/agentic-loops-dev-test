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

// --- F-013 full-text search --------------------------------------------------

describe('todos · search', () => {
  it('search returns only matching todos', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-happy@example.com');
    await createTodo(cookie, 'call the plumber');
    await createTodo(cookie, 'plumber invoice');
    await createTodo(cookie, 'buy milk');

    const { items, nextCursor } = await listTodos(cookie, '?q=plumber');
    expect(items.map((t) => t.title).sort()).toEqual(['call the plumber', 'plumber invoice']);
    expect(nextCursor).toBeNull();
  });

  it('search matches stemmed words', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-stem@example.com');
    await createTodo(cookie, 'buying milk');
    await createTodo(cookie, 'call plumber');

    // 'buying' stems to 'buy' under the english configuration, so the word the
    // user retypes from memory finds the todo they actually wrote.
    expect((await listTodos(cookie, '?q=buy')).items.map((t) => t.title)).toEqual(['buying milk']);
    expect((await listTodos(cookie, '?q=milk')).items.map((t) => t.title)).toEqual(['buying milk']);
    expect((await listTodos(cookie, '?q=buy')).items.map((t) => t.title)).not.toContain(
      'call plumber',
    );
  });

  it('search does not match prefixes', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-prefix@example.com');
    await createTodo(cookie, 'groceries');

    // Whole words after stemming only: no `to_tsquery(... || ':*')` anywhere.
    expect((await listTodos(cookie, '?q=gro')).items).toEqual([]);
    expect((await listTodos(cookie, '?q=groceries')).items.map((t) => t.title)).toEqual([
      'groceries',
    ]);
  });

  it('a search with no matches is an empty page', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-empty@example.com');
    await createTodo(cookie, 'buy milk');

    const res = await ctx.app.inject({ url: '/api/todos?q=submarine', headers: { cookie } });
    expect(res.statusCode).toBe(200); // not a 404
    expect(res.json<{ items: TodoView[]; nextCursor: string | null }>()).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('a stop-word-only query matches nothing', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-stopword@example.com');
    await createTodo(cookie, 'the quick fox');
    await createTodo(cookie, 'another todo');

    // An empty tsquery matches nothing. The failure mode this guards against is
    // it degrading into "no filter" and returning the caller's whole list.
    const { items, nextCursor } = await listTodos(cookie, '?q=the');
    expect(items).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it('search rejects an empty or oversized query', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-validation@example.com');
    await createTodo(cookie, 'anything');

    for (const query of ['?q=', '?q=%20', `?q=${'x'.repeat(101)}`]) {
      const res = await ctx.app.inject({ url: `/api/todos${query}`, headers: { cookie } });
      expect(res.statusCode, query).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    }

    // The boundary itself is accepted, so the bound is 100 and not 99.
    const ok = await ctx.app.inject({
      url: `/api/todos?q=${'x'.repeat(100)}`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('search survives tsquery operator characters', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-operators@example.com');
    await createTodo(cookie, 'plumber and electrician');
    await createTodo(cookie, 'unrelated errand');

    // plainto_tsquery has no syntax to inject; to_tsquery would raise on these
    // and turn user input into a 500.
    for (const q of ['a & b | c :* !', "' OR 1=1 --", '<->', '!!!', 'plumber & electrician']) {
      const res = await ctx.app.inject({
        url: `/api/todos?q=${encodeURIComponent(q)}`,
        headers: { cookie },
      });
      expect(res.statusCode, q).toBe(200);
    }

    // The one that is a real search once the operators are read as words.
    const { items } = await listTodos(cookie, `?q=${encodeURIComponent('plumber & electrician')}`);
    expect(items.map((t) => t.title)).toEqual(['plumber and electrician']);
  });

  it('search respects the deleted filter in both directions', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-deleted@example.com');
    const live = await createTodo(cookie, 'milk for the live list');
    const trashed = await createTodo(cookie, 'milk for the trash');
    // Non-matching rows in both views, so neither assertion can pass by the
    // view filter alone.
    const otherLive = await createTodo(cookie, 'call the plumber');
    const otherTrashed = await createTodo(cookie, 'plumber invoice');
    for (const id of [trashed.id, otherTrashed.id]) {
      expect((await softDelete(cookie, id)).statusCode).toBe(204);
    }
    expect(otherLive.id).toBeTruthy();

    const liveResult = await listTodos(cookie, '?q=milk');
    expect(liveResult.items.map((t) => t.id)).toEqual([live.id]);

    const trashResult = await listTodos(cookie, '?q=milk&deleted=true');
    expect(trashResult.items.map((t) => t.id)).toEqual([trashed.id]);
    expect(trashResult.items[0]!.deletedAt).not.toBeNull();
    // Never a mix, in either direction.
    expect(trashResult.items.map((t) => t.id)).not.toContain(live.id);
  });

  it('search composes with the completed filter', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-completed@example.com');
    const done = await createTodo(cookie, 'plumber visit one');
    const open = await createTodo(cookie, 'plumber visit two');
    // One completed and one open row that do not match, so `completed` alone
    // cannot produce these answers.
    const otherDone = await createTodo(cookie, 'buy milk');
    await createTodo(cookie, 'buy bread');
    for (const id of [done.id, otherDone.id]) {
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/todos/${id}`,
        headers: { cookie },
        payload: { completed: true },
      });
    }

    expect((await listTodos(cookie, '?q=plumber&completed=true')).items.map((t) => t.id)).toEqual([
      done.id,
    ]);
    expect((await listTodos(cookie, '?q=plumber&completed=false')).items.map((t) => t.id)).toEqual([
      open.id,
    ]);
    expect((await listTodos(cookie, '?q=plumber')).items.map((t) => t.id).sort()).toEqual(
      [done.id, open.id].sort(),
    );
  });

  it('search paginates by the same keyset cursor', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-paging@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await createTodo(cookie, `plumber ${i}`)).id);
      await new Promise((r) => setTimeout(r, 2));
    }
    // Noise that must never appear on either page.
    await createTodo(cookie, 'unrelated errand');

    const page1 = await listTodos(cookie, '?q=plumber&limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listTodos(
      cookie,
      `?q=plumber&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items].map((t) => t.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('search returns newest first', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-order@example.com');
    const titles = ['plumber first', 'plumber second', 'plumber third'];
    for (const title of titles) {
      await createTodo(cookie, title);
      // Interleaved non-matching rows, so the order below is the order of the
      // matches and not simply the order of the list.
      await createTodo(cookie, 'unrelated errand');
      await new Promise((r) => setTimeout(r, 2));
    }

    // created_at DESC, not relevance: ADR 0022.
    const { items } = await listTodos(cookie, '?q=plumber');
    expect(items.map((t) => t.title)).toEqual([...titles].reverse());
  });

  it('search never crosses accounts', async () => {
    const alice = await registerUser(ctx.app, 'alice-search@example.com');
    const bob = await registerUser(ctx.app, 'bob-search@example.com');
    // Overlapping titles on purpose: the only thing separating these rows is
    // `user_id` in the WHERE clause.
    const aliceLive = await createTodo(alice.cookie, 'plumber for alice');
    const aliceTrashed = await createTodo(alice.cookie, 'plumber alice deleted');
    await createTodo(alice.cookie, 'alice buys milk');
    expect((await softDelete(alice.cookie, aliceTrashed.id)).statusCode).toBe(204);
    const bobLive = await createTodo(bob.cookie, 'plumber for bob');
    const bobTrashed = await createTodo(bob.cookie, 'plumber bob deleted');
    await createTodo(bob.cookie, 'bob buys milk');
    expect((await softDelete(bob.cookie, bobTrashed.id)).statusCode).toBe(204);

    const bobSearch = await listTodos(bob.cookie, '?q=plumber');
    expect(bobSearch.items.map((t) => t.id)).toEqual([bobLive.id]);

    const bobTrash = await listTodos(bob.cookie, '?q=plumber&deleted=true');
    expect(bobTrash.items.map((t) => t.id)).toEqual([bobTrashed.id]);

    // And the same from Alice's side, so neither account is merely empty.
    const aliceSearch = await listTodos(alice.cookie, '?q=plumber');
    expect(aliceSearch.items.map((t) => t.id)).toEqual([aliceLive.id]);
    const aliceTrash = await listTodos(alice.cookie, '?q=plumber&deleted=true');
    expect(aliceTrash.items.map((t) => t.id)).toEqual([aliceTrashed.id]);

    // A user with no matching rows of their own gets an empty page, never an
    // existence oracle for someone else's todos.
    const carol = await registerUser(ctx.app, 'carol-search@example.com');
    expect((await listTodos(carol.cookie, '?q=plumber')).items).toEqual([]);
    expect((await listTodos(carol.cookie, '?q=plumber&deleted=true')).items).toEqual([]);
  });

  it('search requires authentication', async () => {
    const res = await ctx.app.inject({ url: '/api/todos?q=plumber' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
  });

  it('exposes search counters', async () => {
    const { cookie } = await registerUser(ctx.app, 'search-counters@example.com');
    await createTodo(cookie, 'plumber counter');

    const read = async () => {
      const res = await ctx.app.inject({ url: '/metrics', headers: metricsAuth() });
      const value = (outcome: string) =>
        Number(
          new RegExp(`todo_search_total\\{outcome="${outcome}"\\}\\s+(\\d+)`).exec(res.body)?.[1] ??
            0,
        );
      return { body: res.body, match: value('match'), empty: value('empty') };
    };

    const before = await read();
    await listTodos(cookie, '?q=plumber');
    await listTodos(cookie, '?q=submarine');
    // A plain list must not move either counter.
    await listTodos(cookie);
    const after = await read();

    expect(after.body).toContain('todo_search_total');
    expect(after.body).toContain('todo_search_duration_seconds');
    expect(after.match).toBe(before.match + 1);
    expect(after.empty).toBe(before.empty + 1);
  });

  it('search queries are never logged', async () => {
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
      const { cookie } = await registerUser(logged.app, 'logscan-search@example.com');
      const title = 'SuperSecretSearchableTitle';
      await logged.app.inject({
        method: 'POST',
        url: '/api/todos',
        headers: { cookie },
        payload: { title },
      });

      // A search that matches and one that does not: both log an outcome and a
      // count, and neither may write down what was searched for.
      const miss = 'UnfindableNeedleWord';
      for (const q of [title, miss]) {
        const res = await logged.app.inject({
          url: `/api/todos?q=${encodeURIComponent(q)}`,
          headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
      }

      const output = chunks.join('');
      expect(output.length).toBeGreaterThan(0); // the stream really is capturing
      expect(output).toContain('todo search'); // the search really did log
      expect(output).not.toContain(title);
      expect(output).not.toContain(miss);
    } finally {
      await logged.close();
    }
  });
});
