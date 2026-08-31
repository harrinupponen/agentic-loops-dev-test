import { expect, test } from '@playwright/test';

/**
 * End-to-end over real HTTP against a built server and a real database.
 * There is no UI yet (see specs F-006), so these drive the API directly.
 * Browser-level specs land in this directory alongside them once the UI exists.
 */

type Todo = { id: string; completed: boolean };

const password = 'correct-horse-battery-staple';
const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

test('health endpoints respond', async ({ request }) => {
  const live = await request.get('/healthz');
  expect(live.ok()).toBeTruthy();
  const liveBody = (await live.json()) as { status: string };
  expect(liveBody.status).toBe('ok');

  const ready = await request.get('/readyz');
  expect(ready.ok()).toBeTruthy();
});

test('a user can register, manage todos, and log out', async ({ request }) => {
  const email = uniqueEmail();

  const register = await request.post('/api/auth/register', { data: { email, password } });
  expect(register.status()).toBe(201);

  const created = await request.post('/api/todos', { data: { title: 'ship the pipeline' } });
  expect(created.status()).toBe(201);
  const todo = (await created.json()) as Todo;

  const list = await request.get('/api/todos');
  const listBody = (await list.json()) as { items: Todo[] };
  expect(listBody.items).toHaveLength(1);

  const patched = await request.patch(`/api/todos/${todo.id}`, { data: { completed: true } });
  const patchedBody = (await patched.json()) as Todo;
  expect(patchedBody.completed).toBe(true);

  const removed = await request.delete(`/api/todos/${todo.id}`);
  expect(removed.status()).toBe(204);

  const logout = await request.post('/api/auth/logout');
  expect(logout.status()).toBe(204);

  const afterLogout = await request.get('/api/auth/me');
  expect(afterLogout.status()).toBe(401);
});

test('unauthenticated access is refused', async ({ request }) => {
  const res = await request.get('/api/todos');
  expect(res.status()).toBe(401);
});
