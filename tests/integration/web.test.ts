import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * The browser client is served by this process, at this origin. These tests
 * cover the two new routes and — just as importantly — the two ways the app
 * refuses to start (see ADR 0007).
 */

const FIXTURE_CLIENT = 'tests/fixtures/web';
const NO_CLIENT = 'tests/fixtures/no-web-client';
const ORIGIN = 'http://localhost:3000';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ WEB_ROOT: FIXTURE_CLIENT, ALLOWED_ORIGINS: ORIGIN });
});
afterAll(async () => {
  await ctx.close();
});

describe('web client delivery', () => {
  it('serves the app shell at /', async () => {
    const res = await ctx.app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<h1>');
    expect(res.body).toContain('/app/main.js');
  });

  it('serves static assets with revalidation headers', async () => {
    const script = await ctx.app.inject({ url: '/app/main.js' });
    expect(script.statusCode).toBe(200);
    expect(String(script.headers['content-type'])).toMatch(/javascript/);
    expect(script.headers['cache-control']).toBe('no-cache');
    expect(script.headers.etag).toBeDefined();

    const styles = await ctx.app.inject({ url: '/app/styles.css' });
    expect(styles.statusCode).toBe(200);
    expect(String(styles.headers['content-type'])).toContain('text/css');
    expect(styles.headers['cache-control']).toBe('no-cache');
  });

  it('serves the client to an unauthenticated visitor and sets no cookie', async () => {
    // Both routes are public by design: they carry no user-scoped data, which
    // is why the "another user's resource" case does not apply to them.
    const shell = await ctx.app.inject({ url: '/' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['set-cookie']).toBeUndefined();

    const asset = await ctx.app.inject({ url: '/app/main.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['set-cookie']).toBeUndefined();
  });

  it('refuses path traversal', async () => {
    // The last two climb far enough to reach a file that really exists, and the
    // encoded separator survives the router's own path normalisation — so the
    // guard in the handler is what has to stop them.
    for (const url of [
      '/app/../../package.json',
      '/app/%2e%2e/%2e%2e/package.json',
      '/app/../../../../package.json',
      '/app/..%2f..%2f..%2f..%2fpackage.json',
    ]) {
      const res = await ctx.app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('agentic-todo');
      expect(res.body).not.toContain('dependencies');
    }
  });

  it('unknown asset returns the JSON error shape', async () => {
    const res = await ctx.app.inject({ url: '/app/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = res.json<{ error: { code: string; message: string }; requestId: string }>();
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('no HTML fallback shadows the API', async () => {
    for (const url of ['/does-not-exist', '/api/does-not-exist']) {
      const res = await ctx.app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(String(res.headers['content-type'])).toContain('application/json');
      expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
    }
  });

  it('serves a strict content security policy', async () => {
    const res = await ctx.app.inject({ url: '/' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('web routes are hidden from the API contract', () => {
    const spec = ctx.app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).not.toContain('/');
    expect(Object.keys(spec.paths)).not.toContain('/app/*');
    expect(
      Object.keys(spec.paths).every(
        (p) => p.startsWith('/api/') || p === '/healthz' || p === '/readyz',
      ),
    ).toBe(true);
  });

  it('asset metrics have bounded cardinality', async () => {
    await ctx.app.inject({ url: '/app/main.js' });
    await ctx.app.inject({ url: '/app/styles.css' });

    const res = await ctx.app.inject({ url: '/metrics' });
    const assetRoutes = new Set(
      res.body
        .split('\n')
        .filter((line) => line.startsWith('http_request_duration_seconds_count'))
        .map((line) => /route="([^"]*)"/.exec(line)?.[1] ?? '')
        .filter((route) => route.startsWith('/app')),
    );

    // One label for every asset, not one per filename.
    expect([...assetRoutes]).toEqual(['/app/*']);
    expect(res.body).not.toContain('route="/app/main.js"');
    expect(res.body).not.toContain('route="/app/styles.css"');
  });

  it('cross-origin state changes are rejected when the client is served', async () => {
    const payload = { email: 'origin-check@example.com', password: 'correct-horse-battery' };

    const evil = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload,
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json<{ error: { code: string } }>().error.code).toBe('forbidden');

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload,
    });
    // Reached the handler: no such account, so the credentials are rejected.
    expect(allowed.statusCode).toBe(401);
  });
});

describe('web client boot rules', () => {
  it('refuses to boot in production without a built client', async () => {
    await expect(
      createTestContext({
        WEB_ROOT: NO_CLIENT,
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: ORIGIN,
      }),
    ).rejects.toThrow(/web client/i);

    const outsideProduction = await createTestContext({
      WEB_ROOT: NO_CLIENT,
      ALLOWED_ORIGINS: ORIGIN,
    });
    const res = await outsideProduction.app.inject({ url: '/' });
    expect(res.statusCode).toBe(404);
    await outsideProduction.close();
  });

  it('refuses to boot when serving the client without an origin allowlist', async () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      await expect(
        createTestContext({ WEB_ROOT: FIXTURE_CLIENT, ALLOWED_ORIGINS: '', NODE_ENV }),
      ).rejects.toThrow(/ALLOWED_ORIGINS/);
    }
  });

  it('an unbuilt client does not require an origin allowlist', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const unbuilt = await createTestContext({
        WEB_ROOT: NO_CLIENT,
        ALLOWED_ORIGINS: '',
        NODE_ENV,
      });
      expect(unbuilt.app.hasRoute({ method: 'GET', url: '/' })).toBe(false);
      await unbuilt.close();
    }
  });

  it('boots and serves when the origin allowlist is set', async () => {
    const configured = await createTestContext({
      WEB_ROOT: FIXTURE_CLIENT,
      ALLOWED_ORIGINS: ORIGIN,
    });
    const res = await configured.app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    await configured.close();
  });

  it('the boot log proves the allowlist is populated', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()));

    const logged = await createTestContext(
      {
        WEB_ROOT: FIXTURE_CLIENT,
        ALLOWED_ORIGINS: `${ORIGIN},https://app.example`,
        LOG_LEVEL: 'info',
      },
      { logStream: stream },
    );
    await logged.close();

    const boot = lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => typeof entry.webRoot === 'string');

    expect(boot).toBeDefined();
    expect(boot!.webRoot).toContain('tests/fixtures/web');
    expect(boot!.assetCount).toBeGreaterThan(0);
    expect(boot!.originCount).toBe(2);
  });
});
