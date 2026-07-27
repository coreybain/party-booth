import { scrubEvent, scrubText, scrubValue } from "@partybooth/contracts/scrub";
import { envOptional, sentryEnvironment, serverEnv } from "@partybooth/env/server";

/**
 * Sentry reporting from inside Convex.
 *
 * TODO.md Sprint 1: "Sentry wired into web + Convex; scrubbing rules for
 * tokens/emails/URLs". The web half is `@sentry/nextjs`; this is the Convex
 * half, and it is hand-rolled on purpose:
 *
 * - `@sentry/node` needs `async_hooks`, `process` and a global error hook.
 *   Convex functions run in a V8 isolate with none of that, so the SDK cannot
 *   be initialised there at all.
 * - The wire format we need is one HTTP POST of one envelope. That is small
 *   enough to write, and being pure means it unit-tests fully offline with no
 *   DSN, which is the constraint the whole repo is built under.
 *
 * The scrubbing rules are **not** a third copy: `beforeSend` here is the same
 * `scrubEvent` from `@partybooth/contracts/scrub` that the browser, the Next.js
 * server and the Expo app use.
 *
 * With `SENTRY_DSN` unset every function here is a no-op that falls back to a
 * scrubbed `console.error`, so a deployment with no credentials behaves exactly
 * as it does today.
 */

/** Where Sentry accepts an envelope, plus the auth it needs. */
export interface SentryDsnParts {
  readonly endpoint: string;
  readonly publicKey: string;
  readonly projectId: string;
}

/**
 * Split a DSN into the envelope endpoint and its key.
 *
 * Returns `undefined` for anything unparseable rather than throwing — a typo in
 * the Convex dashboard must degrade to "no error reporting", never to "every
 * request 500s".
 */
export function parseSentryDsn(dsn: string): SentryDsnParts | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }

  const publicKey = url.username;
  const projectId = url.pathname.split("/").filter(Boolean).pop();
  if (!publicKey || !projectId) return undefined;

  const path = url.pathname.replace(/\/[^/]*$/, "");
  return {
    endpoint: `${url.protocol}//${url.host}${path}/api/${projectId}/envelope/`,
    publicKey,
    projectId,
  };
}

/* -------------------------------------------------------------------------- */
/* Event construction                                                          */
/* -------------------------------------------------------------------------- */

export interface ErrorReport {
  /** Where in the deployment this came from, e.g. `"auth.onDelete"`. */
  readonly scope: string;
  readonly error: unknown;
  /** Small, non-PII detail bag. Scrubbed before it leaves regardless. */
  readonly extra?: Record<string, unknown> | undefined;
  readonly level?: "error" | "warning" | undefined;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function describe(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name,
      value: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { type: "UnknownError", value: String(error) };
}

/**
 * Build the event body Sentry expects, already scrubbed.
 *
 * Exported so the tests can assert on the payload without a DSN or a network —
 * the scrubbing is the part that matters, and it must be verifiable offline.
 */
export function buildSentryEvent(report: ErrorReport, now = Date.now()): Record<string, unknown> {
  const described = describe(report.error);

  const event: Record<string, unknown> = {
    event_id: randomHex(16),
    timestamp: now / 1000,
    platform: "javascript",
    logger: "convex",
    level: report.level ?? "error",
    environment: sentryEnvironment(),
    tags: { runtime: "convex", scope: report.scope },
    exception: {
      values: [
        {
          type: described.type,
          value: described.value,
          ...(described.stack === undefined
            ? {}
            : { stacktrace: { frames: [], raw: described.stack } }),
        },
      ],
    },
    ...(report.extra === undefined ? {} : { extra: report.extra }),
  };

  // `scrubEvent` never returns null today, but the signature allows it; falling
  // back to an empty object keeps this function total.
  return scrubEvent(event) ?? {};
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/** True when this deployment has somewhere to send errors. */
export function isSentryConfigured(): boolean {
  const dsn = envOptional(serverEnv, "SENTRY_DSN");
  return dsn !== undefined && parseSentryDsn(dsn) !== undefined;
}

export interface ReportOptions {
  /** Injectable for tests. Defaults to the runtime's `fetch` when it has one. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: number | undefined;
}

/**
 * Report an error, and **never throw**.
 *
 * Two things stop this from being the thing that breaks a request:
 *
 *  - Convex queries and mutations have no `fetch` at all (only actions and HTTP
 *    actions do). When there is none, this falls back to a scrubbed
 *    `console.error`, which is still strictly better than the raw `console.*`
 *    line it replaces.
 *  - Any transport failure is swallowed. A Sentry outage is not an outage of
 *    the party.
 *
 * @returns `true` when an envelope was actually posted.
 */
export async function reportError(
  report: ErrorReport,
  options: ReportOptions = {},
): Promise<boolean> {
  const event = buildSentryEvent(report, options.now);

  const dsn = envOptional(serverEnv, "SENTRY_DSN");
  const parts = dsn === undefined ? undefined : parseSentryDsn(dsn);
  const send = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  if (!parts || !send) {
    logLocally(report, event);
    return false;
  }

  const envelope = [
    JSON.stringify({
      event_id: event["event_id"],
      sent_at: new Date(options.now ?? Date.now()).toISOString(),
    }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");

  try {
    await send(`${parts.endpoint}?sentry_key=${parts.publicKey}&sentry_version=7`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
    });
    return true;
  } catch {
    logLocally(report, event);
    return false;
  }
}

/**
 * Fire-and-forget form for call sites that must not be made async — Convex
 * triggers and mutation paths, mostly. The promise is deliberately unawaited
 * and its rejection is already impossible, but it is caught anyway.
 */
export function captureError(report: ErrorReport, options: ReportOptions = {}): void {
  void reportError(report, options).catch(() => undefined);
}

/**
 * The no-DSN / no-fetch fallback. The message goes through the same scrubber as
 * the wire payload, because the Convex log stream is not a safe place either —
 * it is exactly where the console email sender used to print OTP codes.
 */
function logLocally(report: ErrorReport, event: Record<string, unknown>): void {
  const described = describe(report.error);
  console.error(
    `[convex:${scrubText(report.scope)}] ${scrubText(described.value)}`,
    report.extra === undefined ? "" : scrubValue(report.extra),
    { event_id: event["event_id"] },
  );
}
