import type { EmailMessage, EmailSender, EmailSendResult } from "./types";

export interface ConsoleEmailSenderOptions {
  /**
   * Print the message body — **including the OTP** — to the logs.
   *
   * Opt-in, and only ever honoured on a development deployment (see
   * `getEmailSender`). Without it the banner names the recipient and the
   * subject and stops there: an OTP code correlated with an email address, sat
   * in a log stream, is a sign-in-as-anyone credential for anyone who can read
   * that stream.
   */
  readonly logBody?: boolean | undefined;
  /**
   * Report failure rather than success.
   *
   * Set on any deployment that is not local development. `ok: true` here is a
   * lie that reaches the guest as "check your email" for a message that was
   * never sent — better that the sign-in screen says it could not send.
   */
  readonly refuse?: boolean | undefined;
}

/**
 * The offline sender: the message goes to the Convex logs instead of Resend.
 *
 * This is what runs when `RESEND_API_KEY` is unset — the entire state of the
 * world until the Resend domain verifies — so that the OTP sign-in flow is
 * developable on day one with no credentials: request a code, read it out of
 * `bunx convex logs`, sign in.
 *
 * It does **not** pretend outside development. `getEmailSender` constructs it
 * with `refuse: true` unless `DEPLOYMENT_ENVIRONMENT` is `development`, and the
 * code is only ever printed when `EMAIL_DEBUG_LOG_CODES=1` is set as well.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly id = "console" as const;

  private readonly logBody: boolean;
  private readonly refuse: boolean;

  constructor(options: ConsoleEmailSenderOptions = {}) {
    this.logBody = options.logBody ?? false;
    this.refuse = options.refuse ?? false;
  }

  send(message: EmailMessage): Promise<EmailSendResult> {
    const banner = [
      "",
      "┌─────────────────────────────────────────────────────────────",
      "│ EMAIL NOT SENT — no Resend credentials configured",
      `│ To:      ${message.to}`,
      `│ Subject: ${message.subject}`,
      ...(this.logBody
        ? [
            "├─────────────────────────────────────────────────────────────",
            ...message.text.split("\n").map((line) => `│ ${line}`),
          ]
        : [
            "├─────────────────────────────────────────────────────────────",
            "│ Body withheld. Set EMAIL_DEBUG_LOG_CODES=1 on a development",
            "│ deployment to print it (it contains the sign-in code).",
          ]),
      "└─────────────────────────────────────────────────────────────",
      "",
    ].join("\n");

    if (this.refuse) {
      console.error(
        "[email] RESEND_API_KEY is not set on a non-development deployment — this message was never delivered.",
        banner,
      );
      return Promise.resolve({
        ok: false,
        provider: this.id,
        error: "No email provider is configured on this deployment.",
        // Retrying will not conjure credentials.
        retryable: false,
      });
    }

    console.warn(banner);
    return Promise.resolve({ ok: true, provider: this.id });
  }
}
