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

describe('auth', () => {
  it('registers a user and issues a session cookie', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'a@example.com' });
    expect(String(res.headers['set-cookie'])).toContain('sid=');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser(ctx.app, 'dupe@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dupe@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  it('rejects weak passwords before touching the database', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('does not reveal whether an email exists on failed login', async () => {
    await registerUser(ctx.app, 'known@example.com');
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'known@example.com', password: 'wrong-password-entirely' },
    });
    const unknownUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password-entirely' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it('returns the current user for an authenticated request', async () => {
    const { cookie, user } = await registerUser(ctx.app, 'me@example.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(user);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const { cookie } = await registerUser(ctx.app, 'bye@example.com');
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('ignores a forged session cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'sid=not-a-real-signed-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
