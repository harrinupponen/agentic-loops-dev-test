import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { createMailer, mailTransportStatus, ResendMailer } from '../../src/lib/mailer.js';

/**
 * Never the network. Every case here drives the transport through an injected
 * `fetchImpl`, which is the seam the spec's test plan names: a test that needed
 * api.resend.com would fail on a provider outage, spend quota, and be unable to
 * run on a fork. What it cannot prove — that the provider does what its
 * documentation says — is closed once by hand during the staging rollout.
 */

/** Obviously fake, and never asserted as present anywhere but the header. */
const API_KEY = 'test-key-not-a-real-credential';
const TOKEN = 'A'.repeat(43);
const EXPIRES = new Date('2026-09-16T14:07:31.000Z');

function mailConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost:5432/app',
    COOKIE_SECRET: 'a'.repeat(32),
    MAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: API_KEY,
    MAIL_FROM: 'Agentic Todo <noreply@app.example>',
    APP_BASE_URL: 'https://app.example',
    MAIL_TIMEOUT_MS: '100',
    ...overrides,
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Answers each call from the queue; a shorter queue repeats its last entry. */
function stubFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init = {}) => {
    calls.push({ url: requestUrl(input), init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fetchImpl, calls };
}

const ok = () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
const status = (code: number) =>
  new Response(JSON.stringify({ message: 'nope', to: 'victim@example.org' }), { status: code });

/** No real 1s wait in a unit test; the delay itself is not what is under test. */
const noSleep = () => Promise.resolve();

function resendMailer(answers: Array<Response | Error>, config: Config = mailConfig()) {
  const { fetchImpl, calls } = stubFetch(answers);
  return { mailer: new ResendMailer(config, fetchImpl, noSleep), calls };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

describe('the resend transport', () => {
  it('posts one message to the provider', async () => {
    const { mailer, calls } = resendMailer([ok()]);

    const result = await mailer.sendPasswordReset({
      to: 'user@real-domain.dev',
      token: TOKEN,
      expiresAt: EXPIRES,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://api.resend.com/emails');
    expect(call!.init.method).toBe('POST');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    const payload = body(call!);
    expect(payload.from).toBe('Agentic Todo <noreply@app.example>');
    expect(payload.to).toEqual(['user@real-domain.dev']);
    expect(payload.subject).toBe('Reset your Agentic Todo password');
    expect(String(payload.text)).toContain('Someone asked to reset the password');
    expect(payload).not.toHaveProperty('html');

    expect(result.outcome).toBe('sent');
  });

  it('sends the reset link in the format F-017 parses', async () => {
    const { mailer, calls } = resendMailer([ok()]);
    await mailer.sendPasswordReset({
      to: 'user@real-domain.dev',
      token: TOKEN,
      expiresAt: EXPIRES,
    });

    const text = String(body(calls[0]!).text);
    const links = text.match(/https:\/\/\S+/g) ?? [];
    expect(links).toEqual([`https://app.example/#reset=${TOKEN}`]);
    expect(text).toMatch(/^https:\/\/app\.example\/#reset=[A-Za-z0-9_-]{43}$/m);
    // Nothing after the token: no trailing period, no wrapping <…>, no query.
    expect(text).not.toContain(`${TOKEN}.`);
    expect(text).not.toContain(`<https://`);
  });

  it('does not double the slash when APP_BASE_URL carries a trailing one', async () => {
    const { mailer, calls } = resendMailer(
      [ok()],
      mailConfig({ APP_BASE_URL: 'https://app.example/' }),
    );
    await mailer.sendPasswordReset({
      to: 'user@real-domain.dev',
      token: TOKEN,
      expiresAt: EXPIRES,
    });

    const text = String(body(calls[0]!).text);
    expect(text).toContain(`https://app.example/#reset=${TOKEN}`);
    expect(text).not.toContain('//#reset=');
  });

  it('states when the link expires, in UTC', async () => {
    const { mailer, calls } = resendMailer([ok()]);
    await mailer.sendPasswordReset({
      to: 'user@real-domain.dev',
      token: TOKEN,
      expiresAt: EXPIRES,
    });

    expect(String(body(calls[0]!).text)).toContain('2026-09-16 14:07 UTC');
  });
});

describe('only transient provider failures are retried once', () => {
  it('resolves on a 2xx without a second request', async () => {
    const { mailer, calls } = resendMailer([ok()]);
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).resolves.toMatchObject({ outcome: 'sent', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it.each([400, 401, 403, 422])('rejects a %i without a second request', async (code) => {
    const { mailer, calls } = resendMailer([status(code)]);
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).rejects.toThrow(String(code));
    expect(calls).toHaveLength(1);
  });

  it.each([429, 500, 502, 503])('retries a %i exactly once and then rejects', async (code) => {
    const { mailer, calls } = resendMailer([status(code)]);
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).rejects.toThrow(String(code));
    expect(calls).toHaveLength(2);
  });

  it('retries a network error exactly once and then rejects', async () => {
    const { mailer, calls } = resendMailer([new TypeError('fetch failed')]);
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).rejects.toThrow(/could not be reached/);
    expect(calls).toHaveLength(2);
  });

  it('resolves when the retry succeeds, and reports two attempts', async () => {
    const { mailer, calls } = resendMailer([status(500), ok()]);
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).resolves.toMatchObject({ outcome: 'sent', attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it('abandons a provider that never answers at the timeout', async () => {
    const calls: Call[] = [];
    const hangs: typeof fetch = (input, init = {}) => {
      calls.push({ url: requestUrl(input), init });
      return new Promise<Response>((_resolve, reject) => {
        // Answers only the abort: the transport's own AbortSignal.timeout is
        // the only thing that can end this attempt.
        init.signal!.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    };

    const mailer = new ResendMailer(mailConfig({ MAIL_TIMEOUT_MS: '100' }), hangs, noSleep);
    const started = Date.now();
    await expect(
      mailer.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).rejects.toThrow(/could not be reached/);
    // Two bounded attempts, not a hang: well under the 5s vitest default.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.init.signal instanceof AbortSignal)).toBe(true);
  });

  it('reports a status and nothing else', async () => {
    const { mailer } = resendMailer([status(422)]);
    const err = await mailer
      .sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    const text = `${err!.message} ${err!.stack ?? ''}`;
    expect(text).toContain('422');
    // Never the key, never the token, never the provider's echo of an address.
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('victim@example.org');
    expect(text).not.toContain('user@real-domain.dev');
  });
});

describe('a transport may decline to send', () => {
  it.each([
    'someone@example.com',
    'someone@example.net',
    'someone@example.org',
    'web-1@sub.example.com',
    'someone@host.test',
    'someone@test',
    'someone@anything.invalid',
    'someone@box.localhost',
    'someone@localhost',
    'someone@mail.example',
  ])('never sends to the reserved domain in %s', async (to) => {
    const { mailer, calls } = resendMailer([ok()]);
    await expect(
      mailer.sendPasswordReset({ to, token: TOKEN, expiresAt: EXPIRES }),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: 'suppressed', reason: 'reserved_domain' }),
    );
    expect(calls).toHaveLength(0);
  });

  it('withholds verification mail until a screen exists for it', async () => {
    const { mailer, calls } = resendMailer([ok()]);
    await expect(
      mailer.sendEmailVerification({
        to: 'user@real-domain.dev',
        token: TOKEN,
        expiresAt: EXPIRES,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: 'suppressed', reason: 'no_confirmation_page' }),
    );
    expect(calls).toHaveLength(0);
  });

  it('still delivers a password reset to an address that only looks reserved', async () => {
    const { mailer, calls } = resendMailer([ok()]);
    await mailer.sendPasswordReset({
      to: 'someone@example.computer',
      token: TOKEN,
      expiresAt: EXPIRES,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('createMailer', () => {
  it('returns the delivering transport for MAIL_TRANSPORT=resend', () => {
    expect(createMailer(mailConfig()).transport).toBe('resend');
  });

  it('leaves the existing two transports alone', () => {
    expect(createMailer(mailConfig({ MAIL_TRANSPORT: 'drop' })).transport).toBe('drop');
    expect(createMailer(mailConfig({ MAIL_TRANSPORT: 'console' })).transport).toBe('console');
  });

  it('sends nothing on the drop transport', async () => {
    const dropped = createMailer(mailConfig({ MAIL_TRANSPORT: 'drop' }));
    await expect(
      dropped.sendPasswordReset({ to: 'user@real-domain.dev', token: TOKEN, expiresAt: EXPIRES }),
    ).resolves.toBeUndefined();
  });
});

describe('the mail transport boot line', () => {
  it('says where links point and that verification is withheld', () => {
    expect(mailTransportStatus(mailConfig())).toEqual({
      transport: 'resend',
      appBaseUrl: 'https://app.example',
      verificationWithheld: true,
      unusedMailCredential: false,
    });
  });

  it('reports an unused mail credential rather than failing the boot', () => {
    const config = mailConfig({ MAIL_TRANSPORT: 'drop' });
    expect(mailTransportStatus(config)).toMatchObject({
      transport: 'drop',
      verificationWithheld: false,
      unusedMailCredential: true,
    });
  });

  it('never carries the credential itself', () => {
    expect(JSON.stringify(mailTransportStatus(mailConfig()))).not.toContain(API_KEY);
  });
});
