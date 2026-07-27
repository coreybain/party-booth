import type { EmailAddress, EmailMessage, EmailSender, EmailSendResult } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendSenderOptions {
  apiKey: string;
  from: EmailAddress;
  /** Overridable so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Resend, over plain `fetch`.
 *
 * Deliberately not the `resend` npm SDK: the Convex runtime is a V8 isolate,
 * not Node, and a two-field JSON POST is not worth a dependency that might drag
 * Node built-ins in with it. The trade is that we own the error mapping — which
 * we want anyway, because "OTP didn't arrive" on party night needs to be a
 * legible log line rather than a stack trace.
 */
export class ResendEmailSender implements EmailSender {
  readonly id = "resend" as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendSenderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const from = this.options.from.name
      ? `${this.options.from.name} <${this.options.from.email}>`
      : this.options.from.email;

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
          ...(message.tags === undefined
            ? {}
            : { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }),
        }),
      });
    } catch (error) {
      // Network-level failure: worth retrying.
      return {
        ok: false,
        provider: this.id,
        error: error instanceof Error ? error.message : "network error",
        retryable: true,
      };
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: string } | null;
      return {
        ok: true,
        provider: this.id,
        ...(body?.id === undefined ? {} : { messageId: body.id }),
      };
    }

    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      provider: this.id,
      error: `Resend responded ${response.status}${detail ? `: ${truncate(detail, 300)}` : ""}`,
      // 4xx means we sent something wrong (unverified domain, bad key); retrying
      // will not help. 429 and 5xx will pass.
      retryable: response.status === 429 || response.status >= 500,
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
