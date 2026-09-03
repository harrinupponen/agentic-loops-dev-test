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
