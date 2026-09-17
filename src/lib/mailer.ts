import { MAIL_RETRY_DELAY_MS, type Config } from '../config.js';

/**
 * What a send did, for the caller's counter and log line. `undefined` — what
 * the two local transports and every test fake return — reads as `sent`, so
 * widening the return type changed no existing implementation's contract.
 *
 * A transport may decline to send (ADR 0030), and `suppressed` is how it says
 * so without the caller counting a message that never left as delivered. The
 * `reason` rides here rather than in a metric label, where its cardinality
 * would be permanent.
 */
export interface MailDispatch {
  outcome: 'sent' | 'suppressed';
  reason?: 'reserved_domain' | 'no_confirmation_page';
  attempts?: number;
  durationMs?: number;
}

/** Address and raw token: the two things that must never reach a log line. */
export interface MailMessage {
  to: string;
  token: string;
  expiresAt: Date;
}

/**
 * The seam between this process and anything that delivers mail.
 * See docs/adr/0010-mail-is-an-injected-adapter.md: it is constructed in
 * `buildApp` and passed to routes as an argument, never imported by them, and
 * tests inject a fake through `BuildOptions` rather than reading a token from
 * any HTTP route.
 */
export interface Mailer {
  /** Names the transport in logs and metrics; must be low-cardinality. */
  readonly transport: string;
  /**
   * Must not hang: a network implementation applies its own timeout.
   * Resolving with a {@link MailDispatch} is optional — a transport that always
   * delivers, or never does, says nothing and is read as `sent`.
   */
  sendPasswordReset(message: MailMessage): Promise<MailDispatch | void>;
  /**
   * A method per kind rather than `send(kind, message)`: the interface names
   * what it can send, so a new kind is a compile error everywhere it must be
   * handled instead of a string that silently does nothing.
   */
  sendEmailVerification(message: MailMessage): Promise<MailDispatch | void>;
}

/**
 * Prints the address and the raw token so a developer can complete the flow
 * locally. That is a credential on stdout, and in production stdout is a log
 * aggregator — so this refuses to construct there (ADR 0007). "Remember not to
 * set it in prod" is not a control; a boot failure is.
 */
class ConsoleMailer implements Mailer {
  readonly transport = 'console';

  constructor(nodeEnv: Config['NODE_ENV']) {
    if (nodeEnv === 'production') {
      throw new Error(
        'MAIL_TRANSPORT=console prints recovery tokens to stdout and refuses to run in production. ' +
          'Set MAIL_TRANSPORT=drop until a real transport exists.',
      );
    }
  }

  sendPasswordReset(message: { to: string; token: string; expiresAt: Date }): Promise<void> {
    process.stdout.write(
      `[mail:password-reset] to=${message.to} token=${message.token} ` +
        `expires=${message.expiresAt.toISOString()}\n`,
    );
    return Promise.resolve();
  }

  sendEmailVerification(message: { to: string; token: string; expiresAt: Date }): Promise<void> {
    process.stdout.write(
      `[mail:email-verification] to=${message.to} token=${message.token} ` +
        `expires=${message.expiresAt.toISOString()}\n`,
    );
    return Promise.resolve();
  }
}

/**
 * Sends nothing. This is what production runs until a real transport lands:
 * the endpoints work, tokens are issued, and
 * `mail_messages_total{transport="drop"}` says out loud that nothing is being
 * delivered. The feature ships dark by construction rather than behind a flag.
 */
class DropMailer implements Mailer {
  readonly transport = 'drop';

  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }

  sendEmailVerification(): Promise<void> {
    return Promise.resolve();
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * RFC 2606 / RFC 6761 reserved names. Nothing here can be a real mailbox — that
 * is what the RFCs reserve them for — so refusing them removes no user's mail
 * and removes the whole hard-bounce stream the Playwright suite would otherwise
 * aim at the provider on every deploy (ADR 0030 rule 1). Reputation is an
 * availability control here: a suspended account takes password reset with it.
 */
const RESERVED_DOMAINS = [
  'example.com',
  'example.net',
  'example.org',
  'test',
  'example',
  'invalid',
  'localhost',
];

/** The domain, or any subdomain of it: `web-1@mail.example.com` is reserved too. */
export function isReservedRecipient(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  // Trailing dot: `user@example.com.` is the same domain, fully qualified.
  const domain = address
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.+$/, '');
  return RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** `<base>/#reset=<token>`, trailing slash stripped, nothing after the token. */
export function resetLink(appBaseUrl: string, token: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/#reset=${token}`;
}

/** `2026-09-16 14:07 UTC` — minutes, and never the reader's local zone. */
function expiryText(expiresAt: Date): string {
  return `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function passwordResetBody(appBaseUrl: string, message: MailMessage): string {
  return [
    'Someone asked to reset the password for this address.',
    '',
    `Open this link to choose a new one. It expires at ${expiryText(message.expiresAt)}:`,
    '',
    resetLink(appBaseUrl, message.token),
    '',
    'If this was not you, ignore this message — your password has not changed and',
    'nobody was told whether this address has an account.',
    '',
  ].join('\n');
}

/** One attempt's verdict. `message` is safe to throw: a status and no more. */
type Attempt = { ok: true } | { ok: false; retryable: boolean; message: string };

/**
 * Delivers over the provider's HTTPS API using the runtime's own `fetch`; no
 * SDK, no SMTP client, no provider-neutral abstraction
 * (docs/adr/0029-mail-leaves-over-the-providers-https-api.md).
 *
 * Two things this deliberately does not do: it never awaits anything the
 * response path depends on — the caller dispatches it un-awaited, so a provider
 * outage is a counter, not an outage (ADR 0010) — and it never puts the API key
 * or the raw token into an error, a log field or a metric label.
 */
export class ResendMailer implements Mailer {
  readonly transport = 'resend';

  constructor(
    private readonly config: Config,
    /** The unit-test seam, and the reason no integration test needs a network. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Test seam only: the retry delay is fixed, not configurable. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async sendPasswordReset(message: MailMessage): Promise<MailDispatch> {
    if (isReservedRecipient(message.to)) {
      return { outcome: 'suppressed', reason: 'reserved_domain', attempts: 0, durationMs: 0 };
    }
    return this.send({
      to: message.to,
      subject: 'Reset your Agentic Todo password',
      text: passwordResetBody(this.config.APP_BASE_URL, message),
    });
  }

  /**
   * Withheld entirely (ADR 0030 rule 2): the confirm endpoint takes its token in
   * a request body and no browser surface exists that can post one, so a
   * verification mail today would carry a link that loads the app and does
   * nothing. F-026 builds the screen and deletes this.
   */
  sendEmailVerification(_message: MailMessage): Promise<MailDispatch> {
    return Promise.resolve({
      outcome: 'suppressed',
      reason: 'no_confirmation_page',
      attempts: 0,
      durationMs: 0,
    });
  }

  /**
   * One attempt, then at most one retry after a fixed delay, and only for a
   * failure that could succeed the second time. A 4xx is not retried: an invalid
   * key, an unverified MAIL_FROM or a malformed body fails identically twice.
   *
   * The retry cannot produce a duplicate that matters — the token is stored
   * before the send, so both attempts carry the same link, and a user with two
   * copies has one working token.
   */
  private async send(message: {
    to: string;
    subject: string;
    text: string;
  }): Promise<MailDispatch> {
    const started = Date.now();

    const first = await this.attempt(message);
    if (first.ok) return { outcome: 'sent', attempts: 1, durationMs: Date.now() - started };
    if (!first.retryable) throw new Error(first.message);

    await this.sleep(MAIL_RETRY_DELAY_MS);

    const second = await this.attempt(message);
    if (second.ok) return { outcome: 'sent', attempts: 2, durationMs: Date.now() - started };
    throw new Error(second.message);
  }

  private async attempt(message: { to: string; subject: string; text: string }): Promise<Attempt> {
    try {
      const response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        // JSON, not an SMTP envelope: a CRLF in any value cannot forge a header.
        body: JSON.stringify({
          from: this.config.MAIL_FROM,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        // Bounded, so a provider that never answers cannot outlive the shutdown
        // grace. The URL is a constant and composed from no input: no SSRF.
        signal: AbortSignal.timeout(this.config.MAIL_TIMEOUT_MS),
      });

      // The body is never read — it can echo the recipient — so it is discarded
      // explicitly, which releases the socket instead of leaving it to the
      // garbage collector.
      await response.body?.cancel().catch(() => undefined);

      if (response.ok) return { ok: true };
      // The status and nothing else. 429 is the provider's documented
      // 2-requests/second limit, which is exactly what a retry is for.
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        message: `the mail provider refused the message with status ${response.status}`,
      };
    } catch (err) {
      // A network error or the timeout above. The error's own message can carry
      // the request, so only its constructor name survives.
      const name = err instanceof Error ? err.name : 'Error';
      return {
        ok: false,
        retryable: true,
        message: `the mail provider could not be reached (${name})`,
      };
    }
  }
}

export function createMailer(config: Config): Mailer {
  switch (config.MAIL_TRANSPORT) {
    case 'resend':
      return new ResendMailer(config);
    case 'drop':
      return new DropMailer();
    default:
      return new ConsoleMailer(config.NODE_ENV);
  }
}

/**
 * The boot line's payload. "Is mail live right now, and where do its links
 * point" has to be answerable from the logs without reading the environment —
 * and `unusedMailCredential` is how the one deliberately-unwritten boot rule
 * (a key with nothing to use it) stays visible instead of silent. Never the key.
 */
export function mailTransportStatus(config: Config): {
  transport: Config['MAIL_TRANSPORT'];
  appBaseUrl: string;
  verificationWithheld: boolean;
  unusedMailCredential: boolean;
} {
  const delivering = config.MAIL_TRANSPORT === 'resend';
  return {
    transport: config.MAIL_TRANSPORT,
    appBaseUrl: config.APP_BASE_URL,
    verificationWithheld: delivering,
    unusedMailCredential: !delivering && config.RESEND_API_KEY !== '',
  };
}
