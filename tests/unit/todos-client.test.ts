import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../web/src/api.js';
import {
  applyCreated,
  applyRemoved,
  applyUpdated,
  clearPendingCreate,
  createTodo,
  deleteTodo,
  fetchTodos,
  listPath,
  resolveToggle,
  setCompleted,
  type Todo,
} from '../../web/src/todos.js';

/**
 * `todos.ts` is the DOM-free half of the list screen, so everything that can be
 * tested without a browser is tested here with a stubbed `fetch` — the same
 * shape as `api-client.test.ts`. The DOM half is proved by Playwright.
 */

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failure = (code: string, message: string, status: number) =>
  json({ error: { code, message }, requestId: 'req-1' }, status);

function stubFetch(impl: (input: string, init?: Record<string, unknown>) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

type Init = { method?: string; body?: string; headers: Record<string, string> };
const initOf = (spy: ReturnType<typeof stubFetch>, call = 0) =>
  spy.mock.calls[call]![1] as unknown as Init;
const pathOf = (spy: ReturnType<typeof stubFetch>, call = 0) => spy.mock.calls[call]![0];

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  id,
  title: `todo ${id}`,
  completed: false,
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  // The pending create is module state; a leak between cases would hide the
  // very bug the key lifecycle exists to prevent.
  clearPendingCreate();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the list path echoes the opaque cursor', () => {
  it('asks for twenty rows and no cursor on the first page', () => {
    expect(listPath(null)).toBe('/api/todos?limit=20');
  });

  it('percent-encodes the server cursor verbatim and never sends an offset', () => {
    // Exactly what `nextCursor` looks like once the API has serialised it.
    const cursor = '2026-09-03T10:11:12.345Z';
    expect(listPath(cursor)).toBe('/api/todos?limit=20&cursor=2026-09-03T10%3A11%3A12.345Z');
    expect(listPath(cursor)).not.toMatch(/offset/i);
    expect(decodeURIComponent(listPath(cursor).split('cursor=')[1]!)).toBe(cursor);
  });

  it('sends the cursor the server gave it, not one derived from a row', async () => {
    const spy = stubFetch(() => Promise.resolve(json({ items: [], nextCursor: null }, 200)));

    await fetchTodos('2026-09-03T10:11:12.345Z');

    expect(pathOf(spy)).toBe('/api/todos?limit=20&cursor=2026-09-03T10%3A11%3A12.345Z');
  });
});

describe('create sends a well-formed idempotency key', () => {
  it('sends an Idempotency-Key the server schema accepts', async () => {
    const spy = stubFetch(() => Promise.resolve(json(todo('a'), 201)));

    await createTodo('buy milk');

    const key = initOf(spy).headers['Idempotency-Key']!;
    // IdempotencyKeySchema: min(16) and ^[A-Za-z0-9_-]+$.
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(initOf(spy).method).toBe('POST');
    expect(initOf(spy).body).toBe(JSON.stringify({ title: 'buy milk' }));
  });
});

describe('the create key is bound to the title', () => {
  it('reuses the key when the same title is retried after a failure', async () => {
    const spy = stubFetch(() => Promise.resolve(failure('internal_error', 'Boom', 500)));

    await createTodo('buy milk').catch(() => undefined);
    await createTodo('buy milk').catch(() => undefined);

    // A create the server committed before the connection dropped is replayed,
    // not duplicated.
    expect(initOf(spy, 1).headers['Idempotency-Key']).toBe(
      initOf(spy, 0).headers['Idempotency-Key'],
    );
  });

  it('uses a new key when the user fixes the title and resubmits', async () => {
    const spy = stubFetch(() => Promise.resolve(failure('internal_error', 'Boom', 500)));

    await createTodo('buy milk').catch(() => undefined);
    await createTodo('buy oat milk').catch(() => undefined);

    // Reusing a key for a different body is a 409 by ADR 0005; an honest typo
    // fix must never trigger it.
    expect(initOf(spy, 1).headers['Idempotency-Key']).not.toBe(
      initOf(spy, 0).headers['Idempotency-Key'],
    );
  });

  it('clears the key on 201 so the next create gets a fresh one', async () => {
    const spy = stubFetch(() => Promise.resolve(json(todo('a'), 201)));

    await createTodo('buy milk');
    await createTodo('buy milk');

    expect(initOf(spy, 1).headers['Idempotency-Key']).not.toBe(
      initOf(spy, 0).headers['Idempotency-Key'],
    );
  });

  it('forgets the pending create when the panel is unmounted', async () => {
    const spy = stubFetch(() => Promise.resolve(failure('internal_error', 'Boom', 500)));

    await createTodo('buy milk').catch(() => undefined);
    clearPendingCreate();
    await createTodo('buy milk').catch(() => undefined);

    expect(initOf(spy, 1).headers['Idempotency-Key']).not.toBe(
      initOf(spy, 0).headers['Idempotency-Key'],
    );
  });
});

describe('toggle sends only the completed flag', () => {
  it('patches completed and nothing else', async () => {
    const spy = stubFetch(() => Promise.resolve(json(todo('a', { completed: true }), 200)));

    await setCompleted('a', true);

    expect(pathOf(spy)).toBe('/api/todos/a');
    expect(initOf(spy).method).toBe('PATCH');
    expect(JSON.parse(initOf(spy).body!)).toEqual({ completed: true });
  });
});

describe('applyUpdated replaces the row from the response', () => {
  it('replaces by id and leaves every other row untouched', () => {
    const items = [todo('a'), todo('b')];
    const updated = todo('b', { completed: true });

    const next = applyUpdated(items, updated);

    // The rendered checkbox is whatever the server last said, never the click.
    expect(next.map((t) => t.completed)).toEqual([false, true]);
    expect(next[1]).toBe(updated);
    expect(items[1]!.completed).toBe(false);
  });

  it('no-ops on an unknown id', () => {
    const items = [todo('a')];
    expect(applyUpdated(items, todo('zzz'))).toEqual(items);
  });

  it('prepends a created row and removes a deleted one', () => {
    const items = [todo('a'), todo('b')];

    expect(applyCreated(items, todo('c')).map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(applyRemoved(items, 'a').map((t) => t.id)).toEqual(['b']);
    // A replayed 201 returns a row that is already on screen: replace, never duplicate.
    expect(applyCreated(items, todo('a', { completed: true })).map((t) => t.id)).toEqual([
      'a',
      'b',
    ]);
    expect(applyRemoved(items, 'zzz')).toEqual(items);
  });
});

describe('a toggle shows only what the server confirmed', () => {
  const items = [todo('a'), todo('b', { completed: true })];

  it('takes the checkbox state from the 200 body, not from the click', () => {
    // The user clicked "a" on, and the server is the one that says so.
    const resolution = resolveToggle(items, 'a', true, {
      ok: true,
      todo: todo('a', { completed: true }),
    });

    expect(resolution.checked).toBe(true);
    expect(resolution.removed).toBe(false);
    expect(resolution.report).toBeUndefined();
    expect(resolution.items.map((item) => item.completed)).toEqual([true, true]);
  });

  it('reverts the checkbox to the last confirmed value when the PATCH fails', () => {
    const failure = new ApiFailure(500, 'internal_error', 'Boom', 'req-1');

    // "b" is completed on the server; the click that tried to clear it failed,
    // so the box must go back to checked rather than showing the user's click.
    const resolution = resolveToggle(items, 'b', false, { ok: false, failure });

    expect(resolution.checked).toBe(true);
    expect(resolution.removed).toBe(false);
    expect(resolution.report).toBe(failure);
    expect(resolution.items).toEqual(items);
  });

  it('falls back to the opposite of the click for a row it no longer knows', () => {
    const failure = new ApiFailure(429, 'rate_limited', 'Too many requests.', 'req-1');

    expect(resolveToggle([], 'gone', true, { ok: false, failure }).checked).toBe(false);
  });

  it('drops the row and reports nothing when the PATCH returns 404', () => {
    const failure = new ApiFailure(404, 'not_found', 'Todo not found', 'req-1');

    // Deleted in another tab: the row is gone, which is not an error to show.
    const resolution = resolveToggle(items, 'a', true, { ok: false, failure });

    expect(resolution.items.map((item) => item.id)).toEqual(['b']);
    expect(resolution.removed).toBe(true);
    expect(resolution.checked).toBeNull();
    expect(resolution.report).toBeUndefined();
  });
});

describe('a 404 on delete is treated as already deleted', () => {
  it('resolves rather than throwing when the row is already gone', async () => {
    stubFetch(() => Promise.resolve(failure('not_found', 'Todo not found', 404)));

    await expect(deleteTodo('a')).resolves.toBeUndefined();
  });

  it('still rejects on any other failure', async () => {
    stubFetch(() => Promise.resolve(failure('rate_limited', 'Too many requests.', 429)));

    await expect(deleteTodo('a')).rejects.toMatchObject({ status: 429 });
  });
});
