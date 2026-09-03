/**
 * Every `document` reference for the todo panel. There is no store, no cache and
 * no optimistic update: the rendered list is whatever the server last said about
 * each row, and a write updates only the row it affected (ADR 0008).
 */

import { ApiFailure, GENERIC_FAILURE } from './api.js';
import { byId, el, setText, setVisible, text } from './dom.js';
import {
  applyCreated,
  applyRemoved,
  clearPendingCreate,
  createTodo,
  deleteTodo,
  fetchTodos,
  resolveToggle,
  setCompleted,
  type Todo,
  type ToggleResult,
} from './todos.js';

const LOADING = 'Loading your todos…';
const EMPTY = 'You have no todos yet.';

interface Panel {
  form: HTMLFormElement;
  title: HTMLInputElement;
  submit: HTMLButtonElement | null;
  status: HTMLElement;
  alert: HTMLElement;
  list: HTMLElement;
  more: HTMLButtonElement;
}

// The whole client state: the rows, the opaque cursor, and nothing else. Module
// scope only — never localStorage, sessionStorage, or a readable cookie.
let items: Todo[] = [];
let cursor: string | null = null;
let loading = false;
let panel: Panel | undefined;
let onUnauthorized: () => void = () => undefined;

/**
 * Which mount the current state belongs to. Bumped by both mount and unmount, so
 * every request already in flight belongs to a mount that no longer exists. Each
 * handler captures it before its first `await` and re-checks after every one: a
 * response for the previous account must never reach `items` or the DOM, however
 * slow the network was. Clearing the state on log out is not enough on its own —
 * the continuation would simply put it back.
 */
let generation = 0;

function asFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure(0, 'unknown', GENERIC_FAILURE);
}

/** Resolves the static markup once and wires the two panel-level listeners. */
function bind(): Panel {
  if (panel) return panel;
  const form = byId<HTMLFormElement>('todo-form');
  panel = {
    form,
    title: byId<HTMLInputElement>('todo-title'),
    submit: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
    status: byId('todo-status'),
    alert: byId('todo-alert'),
    list: byId('todo-list'),
    more: byId<HTMLButtonElement>('todo-more'),
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCreate();
  });
  panel.more.addEventListener('click', () => void loadPage());
  return panel;
}

function clearAlert(): void {
  const p = bind();
  p.alert.replaceChildren();
  setVisible(p.alert, false);
}

/** F-006's showAlert rules verbatim, prefixed with the action that failed. */
function showAlert(action: string, failure: ApiFailure): void {
  const p = bind();
  p.alert.replaceChildren();
  if (failure.status >= 500 || failure.code === 'unknown' || failure.status === 0) {
    p.alert.appendChild(
      text(`${action} ${failure.status === 0 ? failure.message : GENERIC_FAILURE}`),
    );
    if (failure.requestId) p.alert.appendChild(el('span', ` Reference: ${failure.requestId}`));
  } else {
    p.alert.appendChild(text(`${action} ${failure.message}`));
  }
  setVisible(p.alert, true);
  p.alert.focus();
}

/** A 401 anywhere is session expiry: drop the panel rather than nag forever. */
function report(action: string, error: unknown): void {
  const failure = asFailure(error);
  if (failure.status === 401) {
    onUnauthorized();
    return;
  }
  showAlert(action, failure);
}

function render(): void {
  const p = bind();
  p.list.replaceChildren(...items.map(row));
  setText(p.status, items.length === 0 ? EMPTY : '');
  setVisible(p.more, cursor !== null);
}

function row(todo: Todo): HTMLElement {
  const item = el('li');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `todo-item-${todo.id}`;
  checkbox.checked = todo.completed;
  checkbox.addEventListener('change', () => void toggle(todo.id, checkbox));

  // The title reaches the page as a text node, never as markup.
  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  setText(label, todo.title);

  const remove = document.createElement('button');
  remove.type = 'button';
  setText(remove, 'Delete');
  // Two rows must be distinguishable by a screen reader, not just by position.
  remove.setAttribute('aria-label', `Delete ${todo.title}`);
  remove.addEventListener('click', () => void removeRow(todo.id, remove));

  item.append(checkbox, label, remove);
  return item;
}

async function loadPage(): Promise<void> {
  const p = bind();
  if (loading) return;
  const g = generation;
  loading = true;
  // Disabled while a page is in flight, so a double click cannot fetch it twice.
  p.more.disabled = true;
  try {
    const page = await fetchTodos(cursor);
    if (g !== generation) return;
    items = [...items, ...page.items];
    cursor = page.nextCursor;
    clearAlert();
    render();
  } catch (error) {
    if (g !== generation) return;
    setText(p.status, '');
    report('Could not load your todos.', error);
  } finally {
    // A stale page must not re-enable the button for, or unblock, the mount that
    // replaced it.
    if (g === generation) {
      loading = false;
      p.more.disabled = false;
    }
  }
}

async function submitCreate(): Promise<void> {
  const p = bind();
  // Trimmed before it is sent: it keeps the idempotency fingerprint stable
  // across a retry, and it catches the whitespace-only title `required` allows.
  const title = p.title.value.trim();
  if (title === '') return;

  const g = generation;
  if (p.submit) p.submit.disabled = true;
  try {
    // createdAt desc means the new row belongs exactly where a re-read would
    // put it, so prepending the 201 body needs no second request.
    const created = await createTodo(title);
    if (g !== generation) return;
    items = applyCreated(items, created);
    p.form.reset();
    clearAlert();
    render();
  } catch (error) {
    if (g !== generation) return;
    report('Could not add that todo.', error);
  } finally {
    if (g === generation && p.submit) p.submit.disabled = false;
  }
}

async function toggle(id: string, checkbox: HTMLInputElement): Promise<void> {
  const g = generation;
  const desired = checkbox.checked;
  checkbox.disabled = true;

  let result: ToggleResult;
  try {
    result = { ok: true, todo: await setCompleted(id, desired) };
  } catch (error) {
    result = { ok: false, failure: asFailure(error) };
  }
  if (g !== generation) return;

  const outcome = resolveToggle(items, id, desired, result);
  items = outcome.items;
  if (outcome.removed) {
    render();
    return;
  }

  // The node this toggle started on may already have been discarded by a
  // render() that a create or a delete elsewhere ran while the PATCH was in
  // flight, so the confirmed value goes to whichever node is on the page now —
  // never to the captured, possibly detached one.
  const current = document.getElementById(checkbox.id);
  if (current instanceof HTMLInputElement) {
    if (outcome.checked !== null) current.checked = outcome.checked;
    current.disabled = false;
  }

  if (outcome.report) report('Could not update that todo.', outcome.report);
  else clearAlert();
}

async function removeRow(id: string, button: HTMLButtonElement): Promise<void> {
  const g = generation;
  button.disabled = true;
  try {
    await deleteTodo(id);
    if (g !== generation) return;
    items = applyRemoved(items, id);
    clearAlert();
    render();
  } catch (error) {
    if (g !== generation) return;
    button.disabled = false;
    report('Could not delete that todo.', error);
  }
}

export function mountTodoList(handlers: { onUnauthorized: () => void }): void {
  onUnauthorized = handlers.onUnauthorized;
  const p = bind();
  // Anything still in flight from a previous mount belongs to a previous account.
  generation += 1;
  loading = false;
  items = [];
  cursor = null;
  p.list.replaceChildren();
  clearPendingCreate();
  clearAlert();
  setText(p.status, LOADING);
  setVisible(p.more, false);
  void loadPage();
}

/**
 * Called on log out. Every trace of the account's todos leaves the page here —
 * a second user on a shared browser must not see the first user's rows, not
 * even for one frame. Bumping the generation is part of that: a request that
 * left before the log out will still resolve, and its continuation must find
 * itself stale rather than rendering the previous account's rows.
 */
export function unmountTodoList(): void {
  generation += 1;
  items = [];
  cursor = null;
  loading = false;
  clearPendingCreate();
  if (!panel) return;
  panel.list.replaceChildren();
  panel.form.reset();
  setText(panel.status, '');
  setVisible(panel.more, false);
  clearAlert();
}
