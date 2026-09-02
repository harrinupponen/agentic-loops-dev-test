import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, apiFetch } from '../../web/src/api.js';

/**
 * The browser API client is deliberately DOM-free so it can be exercised here,
 * in the existing node project, with a stubbed `fetch` and no jsdom.
 */

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function stubFetch(impl: (input: string, init?: Record<string, unknown>) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch error mapping', () => {
  it('parses a 2xx JSON body', async () => {
    stubFetch(() => Promise.resolve(json({ id: 'u1', email: 'a@example.com' }, 200)));
    await expect(apiFetch<{ email: string }>('/api/auth/me')).resolves.toEqual({
      id: 'u1',
      email: 'a@example.com',
    });
  });

  it('maps a 204 to undefined', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(apiFetch('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('maps a non-2xx JSON error body to ApiFailure with status, code, message and requestId', async () => {
    stubFetch(() =>
      Promise.resolve(
        json(
          {
            error: { code: 'email_taken', message: 'An account with that email already exists' },
            requestId: 'req-123',
          },
          409,
        ),
      ),
    );

    const failure = await apiFetch('/api/auth/register', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ApiFailure);
    const api = failure as ApiFailure;
    expect(api.status).toBe(409);
    expect(api.code).toBe('email_taken');
    expect(api.message).toBe('An account with that email already exists');
    expect(api.requestId).toBe('req-123');
  });

  it('maps a non-JSON error body to code "unknown" without leaking the body', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response('<html><body>502 Bad Gateway from a proxy</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const failure = (await apiFetch('/api/auth/me').catch((e: unknown) => e)) as ApiFailure;

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.status).toBe(502);
    expect(failure.code).toBe('unknown');
    expect(failure.message).not.toContain('Bad Gateway');
    expect(failure.message).not.toContain('<html>');
    expect(failure.requestId).toBeUndefined();
  });

  it('maps a rejected fetch to ApiFailure rather than surfacing the transport error', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    const failure = (await apiFetch('/api/auth/me').catch((e: unknown) => e)) as ApiFailure;

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.status).toBe(0);
    expect(failure.code).toBe('network');
  });

  it('sends same-origin credentials, a JSON body, and an abort signal', async () => {
    const spy = stubFetch(() => Promise.resolve(json({ ok: true }, 200)));

    await apiFetch('/api/auth/login', { method: 'POST', body: { email: 'a@example.com' } });

    expect(spy).toHaveBeenCalledTimes(1);
    const [path, init] = spy.mock.calls[0]!;
    expect(path).toBe('/api/auth/login');
    const options = init as {
      method: string;
      body: string;
      credentials: string;
      signal: AbortSignal;
      headers: Record<string, string>;
    };
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(options.body).toBe(JSON.stringify({ email: 'a@example.com' }));
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.headers.accept).toBe('application/json');
    // Anything that can hang gets a timeout — in the browser too.
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the content-type header when there is no body', async () => {
    const spy = stubFetch(() => Promise.resolve(json({ ok: true }, 200)));

    await apiFetch('/api/auth/me');

    const init = spy.mock.calls[0]![1] as { headers: Record<string, string>; body?: string };
    expect(init.headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});
