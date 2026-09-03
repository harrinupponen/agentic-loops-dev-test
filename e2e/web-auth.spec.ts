import { expect, test, type Page } from '@playwright/test';

/**
 * Browser-level proof that the session cookie F-002 issues actually works in a
 * real browser, and that the CSP does not block the app's own script.
 * Selectors are label- and role-based, so the accessibility contract in the
 * spec is under test rather than merely documented.
 */

const password = 'correct-horse-battery-staple';
const uniqueEmail = () => `web-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const signInForm = (page: Page) => page.getByRole('form', { name: 'Sign in' });
const createAccountForm = (page: Page) => page.getByRole('form', { name: 'Create account' });

async function createAccount(page: Page, email: string) {
  await page.getByRole('button', { name: 'Create an account' }).click();
  const form = createAccountForm(page);
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Create account' }).click();
}

test('register, persist across reload, log out', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await expect(signInForm(page)).toBeVisible();

  await createAccount(page, email);

  await expect(page.getByText(email)).toBeVisible();
  const logout = page.getByRole('button', { name: 'Log out' });
  await expect(logout).toBeVisible();

  // The session survives a full page load, which is the point of the cookie.
  await page.reload();
  await expect(page.getByText(email)).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(signInForm(page)).toBeVisible();

  await page.reload();
  await expect(signInForm(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
});

test('rejected credentials are shown to the user', async ({ page }) => {
  await page.goto('/');

  const form = signInForm(page);
  await form.getByLabel('Email').fill(uniqueEmail());
  await form.getByLabel('Password').fill('definitely-not-the-password');
  await form.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await expect(signInForm(page)).toBeVisible();
});

test('duplicate registration is shown to the user', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await createAccount(page, email);
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(signInForm(page)).toBeVisible();

  await createAccount(page, email);
  await expect(page.getByRole('alert')).toContainText('already exists');
});

// Chromium logs every non-2xx response as a console error. The bootstrap call
// for a signed-out visitor is a 401 by design, so that one line is expected;
// a CSP violation or an uncaught exception reads differently and still fails.
const EXPECTED_BOOTSTRAP_401 = /Failed to load resource: the server responded with a status of 401/;

// Cloudflare fronts every *.sevalla.app domain (not something this app can
// opt out of on a Hobby-tier resource — no custom domain, no per-zone
// control) and injects its own bot-detection script into a hidden
// same-origin iframe on every response. Our CSP blocks it like any other
// inline script, which is correct — it just isn't ours to fix. Counted
// separately, not string-matched into the pass/fail set, and capped at
// exactly the number Cloudflare's own presence (the `cf-ray` response
// header) explains: 1 when proxied, 0 when this test runs locally/in CI
// with no CDN in front of it. A second one, or any inline-script violation
// with no `cf-ray` header, means something other than Cloudflare's script
// is being blocked and must still fail.
const CSP_INLINE_SCRIPT_BLOCKED =
  /Executing inline script violates the following Content Security Policy directive 'script-src 'self''/;

test('the page loads with no console errors', async ({ page }) => {
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
  await expect(signInForm(page)).toBeVisible();

  await createAccount(page, uniqueEmail());
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(signInForm(page)).toBeVisible();

  // A CSP that blocks the app's own module shows up here first.
  expect(problems).toEqual([]);

  const throughCloudflare = response?.headers()['cf-ray'] !== undefined;
  expect(cspInlineViolations).toBeLessThanOrEqual(throughCloudflare ? 1 : 0);
});
