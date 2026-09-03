import { expect, test, type Page } from '@playwright/test';
import { addTodo, createAccount, signInForm } from './helpers.js';

/**
 * The list screen in a real browser: the only place the DOM half of the client
 * is exercised (ADR 0006). Every selector is by role or label, so the keyboard
 * and screen-reader contract is under test rather than merely documented.
 */

const rows = (page: Page) => page.getByRole('list', { name: 'Your todos' }).getByRole('listitem');
const addForm = (page: Page) => page.getByRole('form', { name: 'Add todo' });
const loadMore = (page: Page) => page.getByRole('button', { name: 'Load more' });

/** A gate a route handler can wait on, so a response lands exactly when we say. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { held, release: () => release() };
}

const errorBody = (code: string, message: string) =>
  JSON.stringify({ error: { code, message }, requestId: 'req-e2e' });

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const TS = '2026-09-03T10:00:00.000Z';
const stubbed = (id: string, title: string, completed = false) => ({
  id,
  title,
  completed,
  createdAt: TS,
  updatedAt: TS,
});

/**
 * Mounts the panel with a canned session and a canned first page, so a spec
 * about what the client does with a *response* does not have to register an
 * account to get one. The page, the client and the browser are still real; only
 * the two bootstrap calls are answered from here. It also keeps the file inside
 * the API's 10-requests-a-minute auth rate limit, which a real registration in
 * every spec would spend on setup rather than on coverage.
 */
async function mountWithStubbedSession(page: Page, todos: ReturnType<typeof stubbed>[]) {
  await page.route(
    (url) => url.pathname === '/api/auth/me',
    (route) =>
      route.fulfill(
        json({ id: '00000000-0000-4000-8000-000000000001', email: 'stub@example.com' }),
      ),
  );
  await page.route(
    (url) => url.pathname === '/api/todos',
    (route) => route.fulfill(json({ items: todos, nextCursor: null })),
  );
  await page.goto('/');
  await expect(rows(page)).toHaveCount(todos.length);
}

/** Answers every PATCH with `status`; a DELETE succeeds. */
async function failEveryPatch(page: Page, status: number, code: string, message: string) {
  await page.route(
    (url) => url.pathname.startsWith('/api/todos/'),
    (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status,
            contentType: 'application/json',
            body: errorBody(code, message),
          })
        : route.fulfill({ status: 204, body: '' }),
  );
}

test('create, complete, delete a todo', async ({ page }) => {
  await page.goto('/');
  await createAccount(page);

  await expect(page.getByText('You have no todos yet.')).toBeVisible();

  await addTodo(page, 'first todo');
  await addTodo(page, 'second todo');

  // Newest first, in the order the API returned them — a create prepends.
  await expect(rows(page)).toHaveText([/second todo/, /first todo/]);
  await expect(page.getByText('You have no todos yet.')).toBeHidden();

  // No page reload was needed; the row survives one.
  await page.reload();
  await expect(rows(page)).toHaveText([/second todo/, /first todo/]);

  const checkbox = page.getByRole('checkbox', { name: 'second todo' });
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'second todo' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'first todo' })).not.toBeChecked();

  await page.getByRole('button', { name: 'Delete second todo' }).click();
  await expect(rows(page)).toHaveText([/first todo/]);

  await page.reload();
  await expect(rows(page)).toHaveText([/first todo/]);
  await expect(page.getByRole('checkbox', { name: 'second todo' })).toHaveCount(0);
});

test('every control is operable from the keyboard', async ({ page }) => {
  await page.goto('/');
  await createAccount(page);

  await addForm(page).getByLabel('New todo').focus();
  await page.keyboard.type('keyboard todo');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox', { name: 'keyboard todo' })).toBeVisible();

  const checkbox = page.getByRole('checkbox', { name: 'keyboard todo' });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();

  await page.getByRole('button', { name: 'Delete keyboard todo' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(0);
});

test('load more fetches the next keyset page', async ({ page }) => {
  await page.goto('/');
  await createAccount(page);

  // Seeded through the page's own session so the rows belong to this account.
  await page.evaluate(async () => {
    for (let i = 1; i <= 21; i++) {
      await fetch('/api/todos', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `seeded ${String(i).padStart(2, '0')}` }),
      });
    }
  });

  await page.reload();
  await expect(rows(page)).toHaveCount(20);
  await expect(loadMore(page)).toBeVisible();

  await loadMore(page).click();

  // The 21st row is appended, not a second copy of page one.
  await expect(rows(page)).toHaveCount(21);
  await expect(page.getByRole('checkbox', { name: 'seeded 01' })).toBeVisible();
  await expect(loadMore(page)).toBeHidden();
});

test('a second account sees an empty list', async ({ page }) => {
  await page.goto('/');
  await createAccount(page);
  await addTodo(page, 'account A private note');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(signInForm(page)).toBeVisible();

  // The first account's rows must be gone from the DOM the moment it logs out,
  // not merely hidden behind the signed-out panel.
  await expect(page.getByText('account A private note')).toHaveCount(0);

  await createAccount(page);
  await expect(page.getByText('You have no todos yet.')).toBeVisible();
  await expect(page.getByText('account A private note')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
});

test('a list response in flight at log out never reaches the next account', async ({ page }) => {
  const LEAKED = 'account A private note';

  await page.goto('/');
  await createAccount(page);
  await addTodo(page, LEAKED);

  // Hold the first account's next list response open, so it can only arrive
  // after somebody else has signed in on this browser. Fulfilled from the test
  // rather than the server: the point is a response that carries A's rows and
  // lands during B's session, which is the shared-browser leak.
  const { held, release } = gate();
  let holdNext = true;
  await page.route(
    (url) => url.pathname === '/api/todos',
    async (route) => {
      if (!holdNext) {
        await route.continue();
        return;
      }
      holdNext = false;
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: LEAKED,
              completed: false,
              createdAt: '2026-09-03T10:00:00.000Z',
              updatedAt: '2026-09-03T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      });
    },
  );

  // Mounts the panel and issues the list request that is now held open.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(signInForm(page)).toBeVisible();

  await createAccount(page);
  await expect(page.getByText('You have no todos yet.')).toBeVisible();

  const landed = page.waitForResponse((response) => response.url().includes('/api/todos'));
  release();
  await landed;
  // The continuation belongs to a mount that no longer exists, so it must do
  // nothing at all — not render, not repopulate the in-memory list.
  await page.waitForTimeout(250);

  await expect(page.getByText(LEAKED)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('You have no todos yet.')).toBeVisible();
});

test('a failed toggle leaves the checkbox showing the server value', async ({ page }) => {
  await mountWithStubbedSession(page, [stubbed('t-1', 'unhappy toggle')]);

  await failEveryPatch(page, 500, 'internal_error', 'Boom');

  // click(), not check(): check() asserts the box stays checked, and the whole
  // point here is that the failure puts it back.
  await page.getByRole('checkbox', { name: 'unhappy toggle' }).click();

  await expect(page.getByRole('alert')).toContainText('Could not update that todo.');
  await expect(page.getByRole('checkbox', { name: 'unhappy toggle' })).not.toBeChecked();
});

test('a toggle answered with 404 drops the row and shows no error', async ({ page }) => {
  await mountWithStubbedSession(page, [
    stubbed('t-1', 'deleted elsewhere'),
    stubbed('t-2', 'surviving row'),
  ]);

  await failEveryPatch(page, 404, 'not_found', 'Todo not found');

  // click(), not check(): the row is about to leave the DOM entirely.
  await page.getByRole('checkbox', { name: 'deleted elsewhere' }).click();

  // Gone in another tab: the row leaves the list, and that is not an error.
  await expect(rows(page)).toHaveText([/surviving row/]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a toggle that lands after the list re-renders updates the visible checkbox', async ({
  page,
}) => {
  await mountWithStubbedSession(page, [stubbed('t-1', 'slow toggle'), stubbed('t-2', 'other row')]);

  const { held, release } = gate();
  await page.route(
    (url) => url.pathname.startsWith('/api/todos/'),
    async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      // Held open so the delete below re-renders the list first.
      await held;
      await route.fulfill(json(stubbed('t-1', 'slow toggle', true)));
    },
  );

  await page.getByRole('checkbox', { name: 'slow toggle' }).click();

  // A delete re-renders the whole list, which discards the node the toggle
  // started on. The confirmed value must still reach the box the user sees.
  await page.getByRole('button', { name: 'Delete other row' }).click();
  await expect(rows(page)).toHaveCount(1);

  const landed = page.waitForResponse((response) => response.request().method() === 'PATCH');
  release();
  await landed;

  await expect(page.getByRole('checkbox', { name: 'slow toggle' })).toBeChecked();
});

test('an expired session returns to the sign-in form', async ({ page, context }) => {
  await page.goto('/');
  await createAccount(page);
  await addTodo(page, 'todo before expiry');

  await context.clearCookies();

  await page.getByRole('button', { name: 'Delete todo before expiry' }).click();

  // A dead cookie returns the page to sign-in rather than leaving an error and
  // previously-authorised rows on screen.
  await expect(signInForm(page)).toBeVisible();
  await expect(page.getByText('todo before expiry')).toHaveCount(0);
});

// Chromium logs every non-2xx response as a console error; the bootstrap call
// for a signed-out visitor is a 401 by design. See web-auth.spec.ts.
const EXPECTED_BOOTSTRAP_401 = /Failed to load resource: the server responded with a status of 401/;
const CSP_INLINE_SCRIPT_BLOCKED =
  /Executing inline script violates the following Content Security Policy directive 'script-src 'self''/;

test('the todo journey logs no console errors', async ({ page }) => {
  const problems: string[] = [];
  let cspInlineViolations = 0;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (EXPECTED_BOOTSTRAP_401.test(message.text())) return;
    if (CSP_INLINE_SCRIPT_BLOCKED.test(message.text())) {
      cspInlineViolations += 1;
      return;
    }
    problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  const response = await page.goto('/');
  await createAccount(page);
  await addTodo(page, 'journey todo');
  await page.getByRole('checkbox', { name: 'journey todo' }).check();
  await expect(page.getByRole('checkbox', { name: 'journey todo' })).toBeChecked();
  await page.getByRole('button', { name: 'Delete journey todo' }).click();
  await expect(rows(page)).toHaveCount(0);

  expect(problems).toEqual([]);

  const throughCloudflare = response?.headers()['cf-ray'] !== undefined;
  expect(cspInlineViolations).toBeLessThanOrEqual(throughCloudflare ? 1 : 0);
});
