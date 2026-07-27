/**
 * Outbound email, behind an interface.
 *
 * PartyBooth sends three kinds of email — OTP codes, organiser invitations and
 * co-host invitations — and all of them go through {@link EmailSender}. The
 * point of the interface is that the whole product, including the OTP sign-in
 * flow, works with **no Resend credentials at all**: the console sender prints
 * the message (code included) to the Convex logs so a developer can sign in.
 */

export interface EmailAddress {
  email: string;
  name?: string | undefined;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always present — this is the accessible fallback. */
  text: string;
  /** Optional HTML body. */
  html?: string | undefined;
  replyTo?: string | undefined;
  /**
   * Provider-side tags for deliverability triage. Never put PII in here — the
   * values end up in Resend's dashboard and in Sentry breadcrumbs.
   */
  tags?: Record<string, string> | undefined;
}

export type EmailSendResult =
  | { ok: true; provider: EmailProviderId; messageId?: string }
  | { ok: false; provider: EmailProviderId; error: string; retryable: boolean };

export type EmailProviderId = "resend" | "console";

export interface EmailSender {
  readonly id: EmailProviderId;
  /**
   * Deliver a message. Implementations must **not** throw for provider
   * failures — a bounced OTP should surface as a friendly "we couldn't send
   * that" rather than a 500 in the middle of a party. They may throw for
   * programmer errors (a malformed message).
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
