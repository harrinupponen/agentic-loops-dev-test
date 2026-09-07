import type { Config } from '../config.js';

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
  /** Must not hang: a network implementation applies its own timeout. */
  sendPasswordReset(message: { to: string; token: string; expiresAt: Date }): Promise<void>;
  /**
   * A method per kind rather than `send(kind, message)`: the interface names
   * what it can send, so a new kind is a compile error everywhere it must be
   * handled instead of a string that silently does nothing.
   */
  sendEmailVerification(message: { to: string; token: string; expiresAt: Date }): Promise<void>;
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

export function createMailer(config: Config): Mailer {
  return config.MAIL_TRANSPORT === 'drop' ? new DropMailer() : new ConsoleMailer(config.NODE_ENV);
}
