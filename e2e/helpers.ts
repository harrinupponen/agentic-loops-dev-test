import { expect, type Page } from '@playwright/test';

/** Shared browser-journey helpers. Selectors are role- and label-based only. */

export const PASSWORD = 'correct-horse-battery-staple';

export const uniqueEmail = () =>
  `web-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

export const signInForm = (page: Page) => page.getByRole('form', { name: 'Sign in' });

export async function createAccount(page: Page, email = uniqueEmail()): Promise<string> {
  await page.getByRole('button', { name: 'Create an account' }).click();
  const form = page.getByRole('form', { name: 'Create account' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  return email;
}

export async function addTodo(page: Page, title: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Add todo' });
  await form.getByLabel('New todo').fill(title);
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('checkbox', { name: title })).toBeVisible();
}
