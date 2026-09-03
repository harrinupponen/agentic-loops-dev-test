/**
 * The todo list's logic, with no DOM reference anywhere, so the node-environment
 * unit project can exercise it without jsdom (ADR 0006). Everything that touches
 * the page lives in `todo-list.ts` and is proved by Playwright.
 */

import { ApiFailure, apiFetch } from './api.js';

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TodoPage {
  items: Todo[];
  nextCursor: string | null;
}

/** Fixed by the client; the server caps it at 100 anyway. */
export const PAGE_SIZE = 20;

/**
 * `nextCursor` is opaque: echoed back exactly as the server serialised it, never
 * parsed into a Date and never recomputed from a rendered row — a row that gets
 * deleted would take the cursor with it. Keyset only, never an offset (ADR 0002).
 */
export function listPath(cursor: string | null): string {
  const query = `limit=${PAGE_SIZE}`;
  return cursor === null
    ? `/api/todos?${query}`
    : `/api/todos?${query}&cursor=${encodeURIComponent(cursor)}`;
}

export function fetchTodos(cursor: string | null): Promise<TodoPage> {
  return apiFetch<TodoPage>(listPath(cursor));
}

/**
 * One pending create at a time, bound to the title the user is trying to send.
 * A retry of the same title reuses the key, so a create the server committed
 * before the connection dropped is replayed instead of duplicated; a changed
 * title gets a new key, because ADR 0005 answers a key reused for a different
 * body with a 409 and an honest typo fix must never trigger that.
 */
let pendingCreate: { key: string; title: string } | undefined;

export function pendingCreateKey(title: string): string {
  if (pendingCreate?.title !== title) {
    // 36 characters of [0-9a-f-], which satisfies IdempotencyKeySchema. Needs a
    // secure context: production is HTTPS and development is localhost.
    pendingCreate = { key: globalThis.crypto.randomUUID(), title };
  }
  return pendingCreate.key;
}

export function clearPendingCreate(): void {
  pendingCreate = undefined;
}

export async function createTodo(title: string): Promise<Todo> {
  const created = await apiFetch<Todo>('/api/todos', {
    method: 'POST',
    body: { title },
    headers: { 'Idempotency-Key': pendingCreateKey(title) },
  });
  // Committed: the next todo must get a fresh key or it would 409 against this one.
  clearPendingCreate();
  return created;
}

export function setCompleted(id: string, completed: boolean): Promise<Todo> {
  return apiFetch<Todo>(`/api/todos/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { completed },
  });
}

export async function deleteTodo(id: string): Promise<void> {
  try {
    await apiFetch<void>(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    // Already deleted — in another tab, or by a retry of this same click. The
    // user asked for it to be gone and it is gone; that is not an error.
    if (error instanceof ApiFailure && error.status === 404) return;
    throw error;
  }
}

/**
 * The three list transforms. A write updates exactly the row it affected, from
 * that write's own response, and nothing refetches — ADR 0008.
 */

export function applyUpdated(items: readonly Todo[], updated: Todo): Todo[] {
  return items.map((item) => (item.id === updated.id ? updated : item));
}

export function applyCreated(items: readonly Todo[], created: Todo): Todo[] {
  // A replayed 201 returns a row that is already on screen; replace it rather
  // than showing the same todo twice.
  return items.some((item) => item.id === created.id)
    ? applyUpdated(items, created)
    : [created, ...items];
}

export function applyRemoved(items: readonly Todo[], id: string): Todo[] {
  return items.filter((item) => item.id !== id);
}

/** What a PATCH came back with: the row the server confirmed, or why it did not. */
export type ToggleResult = { ok: true; todo: Todo } | { ok: false; failure: ApiFailure };

export interface ToggleResolution {
  /** The list after the outcome is applied. */
  items: Todo[];
  /** What that row's checkbox must show now; `null` when the row is gone. */
  checked: boolean | null;
  /** The row left the list, so the whole list is re-rendered rather than one box. */
  removed: boolean;
  /** The failure to report, if any. A `404` is not one: the row is simply gone. */
  report?: ApiFailure;
}

/**
 * The whole "what should this row show now" decision, kept DOM-free so it is
 * unit-testable: the box never shows a value the server has not confirmed, and a
 * `404` means the row was deleted elsewhere and is dropped without an error.
 */
export function resolveToggle(
  items: readonly Todo[],
  id: string,
  desired: boolean,
  result: ToggleResult,
): ToggleResolution {
  if (result.ok) {
    return {
      items: applyUpdated(items, result.todo),
      checked: result.todo.completed,
      removed: false,
    };
  }
  if (result.failure.status === 404) {
    return { items: applyRemoved(items, id), checked: null, removed: true };
  }
  // Back to the last value the server confirmed, never the user's click.
  const confirmed = items.find((item) => item.id === id)?.completed;
  return {
    items: [...items],
    checked: confirmed ?? !desired,
    removed: false,
    report: result.failure,
  };
}
