import { serverEnv, serverFeatures } from "@partybooth/env/server";

import { captureError } from "../sentry";
import { ConsoleEmailSender } from "./console";
import { ResendEmailSender } from "./resend";
import type { EmailMessage, EmailSender, EmailSendResult } from "./types";

export * from "./types";
export { ConsoleEmailSender } from "./console";
export { ResendEmailSender } from "./resend";
export * from "./templates";

let cached: EmailSender | undefined;

/**
 * The sender to use right now.
 *
 * Resolved lazily and cached, because `@partybooth/env` only validates a
 * variable when it is read — importing this module must never be the thing that
 * breaks a deployment with no credentials.
 *
 * With `RESEND_API_KEY` and `RESEND_FROM_EMAIL` set, mail goes to Resend.
 * Without them it goes to the Convex logs — but only on a **development**
 * deployment, and only with the body withheld unless it is explicitly asked
 * for. Anywhere else the console sender reports failure instead of faking a
 * success, so the sign-in screen says "we couldn't send that" rather than
 * "check your email" for a message that only ever existed in a log line.
 *
 * The check is `DEPLOYMENT_ENVIRONMENT`, not `NODE_ENV`: Convex does not set
 * `NODE_ENV`, so the old guard never fired in the one runtime it was written
 * for. Note this path is also taken when `RESEND_API_KEY` is *present but
 * malformed* — the schema requires the `re_` prefix, and a mistyped key fails
 * `serverFeatures.resend` exactly like a missing one.
 *
 * Nothing in between throws.
 */
export function getEmailSender(): EmailSender {
  if (cached) return cached;

  if (!serverFeatures.resend) {
    const isDevelopment = serverEnv.DEPLOYMENT_ENVIRONMENT === "development";
    cached = new ConsoleEmailSender({
      refuse: !isDevelopment,
      logBody: isDevelopment && serverEnv.EMAIL_DEBUG_LOG_CODES === "1",
    });
    return cached;
  }

  cached = new ResendEmailSender({
    apiKey: serverEnv.RESEND_API_KEY,
    from: {
      email: serverEnv.RESEND_FROM_EMAIL,
      name: serverEnv.RESEND_FROM_NAME,
    },
  });
  return cached;
}

/** Test seam — lets a test install a fake sender, or reset after one. */
export function setEmailSender(sender: EmailSender | undefined): void {
  cached = sender;
}

/**
 * Send, and never throw.
 *
 * Every caller here is on a user-facing path (a guest tapping "email me a
 * code"), so a provider outage must degrade to a friendly failure rather than
 * an exception escaping a Convex action.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  const sender = getEmailSender();
  try {
    const result = await sender.send(message);
    if (!result.ok) {
      // Reported rather than logged: an OTP that never arrives is invisible
      // from the outside, and on party night nobody is tailing Convex logs.
      captureError({
        scope: "email.send",
        error: new Error(`Delivery failed via ${result.provider}: ${result.error}`),
        extra: { provider: result.provider, retryable: result.retryable },
        level: "warning",
      });
    }
    return result;
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    captureError({ scope: "email.send", error, extra: { provider: sender.id } });
    return { ok: false, provider: sender.id, error: description, retryable: true };
  }
}
