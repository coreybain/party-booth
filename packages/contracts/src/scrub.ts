/**
 * PII / secret scrubbing for anything leaving the process — today that means
 * Sentry events from the browser, the Next.js server/edge runtimes, the Expo
 * app and the Convex deployment.
 *
 * This lives in `@partybooth/contracts` rather than in one app because there
 * must be exactly **one** implementation: three divergent copies is how a
 * six-digit OTP ends up scrubbed on the web and shipped verbatim from a phone.
 * `apps/web/src/lib/sentry-scrub.ts`, `apps/mobile/src/lib/scrub.ts` and
 * `packages/backend/convex/lib/sentry.ts` are all thin re-exports of this file.
 *
 * PLAN.md requires "Sentry with scrubbing"; TODO.md Sprint 1 spells it out as
 * "scrubbing rules for tokens/emails/URLs". PartyBooth leaks badly if any of
 * these reach a third party:
 *
 * - **Email addresses** — the only identifier organisers and guests have.
 * - **Six-digit OTP codes** and **six-digit event join codes** — low-entropy
 *   secrets that grant access.
 * - **Invite / QR tokens** — high-entropy path segments under `/join/<token>`.
 * - **Signed media URLs** — short-lived but readable by anyone holding them;
 *   the signature always lives in the query string.
 * - **Bearer tokens, JWTs and provider API keys** (`re_…`, UploadThing V7
 *   tokens, Convex deploy keys) that turn up in error messages and headers.
 *
 * Everything here is pure and synchronous so it unit-tests fully offline —
 * `apps/web/src/lib/sentry-scrub.test.ts` is the specification.
 *
 * The functions accept a structural subset of Sentry's `Event`/`Breadcrumb`
 * rather than the SDK types, so the tests never need to import the SDK.
 */

/** Placeholder written over anything considered sensitive. */
export const REDACTED = "[redacted]";

/** Guard against pathological or cyclic payloads. */
const MAX_DEPTH = 8;

/* -------------------------------------------------------------------------- */
/* String-level rules                                                          */
/* -------------------------------------------------------------------------- */

/** Deliberately greedy, so unusual-but-valid addresses are still caught. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** JSON Web Tokens — Better Auth session tokens are JWTs. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/** `Bearer <anything>` in headers, curl snippets and error strings. */
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Provider key prefixes: Resend (`re_`), Convex deploy keys, webhook secrets. */
const PROVIDER_KEY_RE = /\b(?:re|sk|pk|rk|whsec|prod|dev)_[A-Za-z0-9_-]{12,}/g;

/** `secret=…`, `token: …`, `apiKey="…"` inside free-form text. */
const INLINE_ASSIGNMENT_RE =
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|client[-_]?secret|secret|password|passwd|token|otp|signature)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)"']+)/gi;

/**
 * A standalone six-digit run: OTP codes and event join codes.
 *
 * The boundaries exclude `-`, `_` and `/` on purpose. Without that, hashed
 * chunk names in stack frames (`main-app-123456.js`, `/static/123456/…`) get
 * mangled and Sentry can no longer group the issue. `.` is allowed as a
 * boundary because sentences end with one ("Your code is 123456.").
 */
const SIX_DIGIT_RE = /(?<![0-9A-Za-z_\-/])[0-9]{6}(?![0-9A-Za-z_\-/])/g;

/** Any absolute http(s) URL, so it can be rewritten structurally. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Key patterns tested against a normalised (camelCase → snake_case, lowered)
 * key name. Matching keys are replaced wholesale rather than scrubbed, because
 * the value is a secret regardless of its shape.
 *
 * `code` is matched only as a whole key or with a known prefix, so
 * `statusCode`, `errorCode` and `code: "ENOENT"`-style diagnostics survive.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^(authorization|auth|cookie|set_cookie|proxy_authorization)$/,
  /(^|[-_.])(token|tokens|jwt|secret|secrets|password|passwd|credential|credentials|api_key|apikey|access_key|accesskey|private_key|signature|sig|session)([-_.]|$)/,
  /(^|[-_.])(otp|email|emails|e_mail|phone|username|dsn)([-_.]|$)/,
  /(^|[-_.])((otp|join|invite|event|access|verification|reset|confirmation)[-_.]?code)([-_.]|$)/,
  /^code$/,
  /(^|[-_.])(x_amz_[a-z_]+|x_goog_[a-z_]+|x_ut_[a-z_]+)([-_.]|$)/,
  /(^|[-_.])(ip|forwarded|x_real_ip|x_forwarded_for)([-_.]|$)/,
];

/** `sessionToken` → `session_token`, `X-Real-IP` → `x_real_ip`. */
function normaliseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/** True when a header / query / object key names something we must not send. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalised));
}

/** Path prefixes whose *next* segment is a bearer-grade secret. */
const SECRET_PATH_SEGMENTS: readonly string[] = ["join", "invite", "i", "otp", "reset"];

/**
 * The same rule as {@link SECRET_PATH_SEGMENTS} but for *relative* paths, which
 * is how Sentry records `event.transaction` and how routers report navigation.
 * The lookbehind stops it firing inside an absolute URL that {@link scrubUrl}
 * has already rewritten.
 */
const SECRET_RELATIVE_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9.:])/(${SECRET_PATH_SEGMENTS.join("|")})/([A-Za-z0-9._~-]+)`,
  "g",
);

/**
 * Rewrite a single URL: drop credentials, drop the entire query string and
 * fragment, and replace high-entropy path secrets (`/join/<token>`) with a
 * placeholder. Origin and route shape survive, which is all Sentry needs in
 * order to group an issue.
 */
export function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  url.username = "";
  url.password = "";

  const hadQuery = url.search.length > 0 || url.hash.length > 0;
  url.search = "";
  url.hash = "";

  const segments = url.pathname.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]?.toLowerCase();
    if (segments[index] && previous && SECRET_PATH_SEGMENTS.includes(previous)) {
      segments[index] = REDACTED;
    }
  }
  url.pathname = segments.join("/");

  return hadQuery ? `${url.toString()}?${REDACTED}` : url.toString();
}

/**
 * Apply every string rule, in an order chosen so a broad rule cannot eat the
 * input a narrower rule needs: URLs go first, so their query strings are gone
 * before the email and six-digit passes ever see them.
 */
export function scrubText(input: string): string {
  return input
    .replace(URL_RE, (match) => scrubUrl(match))
    .replace(SECRET_RELATIVE_PATH_RE, (_match, segment: string) => `/${segment}/${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PROVIDER_KEY_RE, REDACTED)
    .replace(INLINE_ASSIGNMENT_RE, (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(EMAIL_RE, REDACTED)
    .replace(SIX_DIGIT_RE, REDACTED);
}

/* -------------------------------------------------------------------------- */
/* Structural walk                                                             */
/* -------------------------------------------------------------------------- */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-copy `value`, replacing sensitive keys outright and running
 * {@link scrubText} over every remaining string. Cycles and over-deep objects
 * collapse to a placeholder instead of throwing.
 */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1, seen));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = isSensitiveKey(key) ? REDACTED : scrubValue(source[key], depth + 1, seen);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Event-level rules                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keys carrying no user data that must survive untouched — mangling them
 * breaks Sentry's grouping, release health and source-map lookup.
 *
 * `server_name` is deliberately absent: it is dropped, not scrubbed, because
 * it can expose internal hostnames.
 */
const PRESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "event_id",
  "timestamp",
  "start_timestamp",
  "platform",
  "level",
  "logger",
  "release",
  "environment",
  "dist",
  "sdk",
  "type",
  "modules",
  "measurements",
]);

/** Only the opaque account id is useful to us; the rest identifies a person. */
function scrubUser(user: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(user)) return undefined;
  const id = user["id"];
  return typeof id === "string" || typeof id === "number" ? { id } : undefined;
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction` implementation.
 *
 * Returns a new event and never mutates the input. The `null` branch exists so
 * that future "drop this event entirely" rules have an obvious home; nothing
 * is dropped today.
 *
 * The generic is constrained to `object` rather than a structural event shape
 * because Sentry's `ErrorEvent` / `TransactionEvent` are interfaces, and
 * interfaces have no implicit index signature — anything narrower would refuse
 * the SDK's own types.
 */
export function scrubEvent<TEvent extends object>(event: TEvent): TEvent | null {
  const source = event as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    if (key === "user" || key === "server_name") continue;
    result[key] = PRESERVED_TOP_LEVEL_KEYS.has(key) ? source[key] : scrubValue(source[key]);
  }

  const user = scrubUser(source["user"]);
  if (user) result["user"] = user;

  return result as TEvent;
}

/**
 * Sentry `beforeBreadcrumb` implementation. Breadcrumbs are the likeliest
 * accidental leak: `fetch` and `navigation` crumbs record full URLs, including
 * signed-URL query strings and `/join/<token>` paths.
 */
export function scrubBreadcrumb<TCrumb extends object>(crumb: TCrumb): TCrumb | null {
  return scrubValue(crumb) as TCrumb;
}
