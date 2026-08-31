import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, registerUser, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
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

  it('never leaks another user\'s todo', async () => {
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
    expect(list.json().items).toHaveLength(0);
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
