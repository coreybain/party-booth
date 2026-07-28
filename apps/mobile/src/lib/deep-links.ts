/**
 * Join deep-link parsing.
 *
 * A guest can arrive three ways (PLAN.md → "Guest mobile web", TODO.md Sprint 2):
 *
 *   1. Universal / App Link  `https://<site>/join/<token>`  — scanning the printed QR
 *   2. Custom scheme         `partybooth://join/<token>`    — OAuth callbacks, app-to-app
 *   3. Typing the six-digit code printed under the QR
 *
 * All three funnel into the same `JoinTarget`. This module is deliberately free of any
 * React Native import so it can be unit-tested in plain Node.
 *
 * The *shape* of a code and a token is not decided here — `@partybooth/contracts/codes`
 * owns that, and Convex validates against the same functions. This module only decides
 * how a URL is taken apart. Anything it returns is already in the canonical form the
 * join mutation expects, so the app never sends a token the backend will bounce.
 */

import {
  inviteUrl,
  isValidEventCode,
  isValidInviteToken,
  JOIN_PATH_SEGMENT,
  normalizeInviteToken,
} from "@partybooth/contracts/codes";

/** URL scheme registered in app.config.ts. */
export const APP_SCHEME = "partybooth";

/**
 * Path segment that carries an invite, on both the website and the custom
 * scheme. Re-exported from contracts rather than restated: the same segment is
 * what `apps/web` routes and what the printed QR encodes, so a change there has
 * to break the parser here rather than quietly stop matching it.
 */
export { JOIN_PATH_SEGMENT };

export type JoinTarget =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "code"; readonly code: string };

/**
 * Normalise typed input into a six-digit code.
 *
 * Deliberately more lenient than the contracts' `normalizeEventCode` (which strips only
 * whitespace and hyphens): this is hand-typed phone input read off a printed sign, and
 * some keyboards emit characters nobody predicted, so strip everything that is not a
 * digit. What comes out is plain digits, which `isValidEventCode` — the same check the
 * backend runs — then has to accept. Returns `null` otherwise.
 */
export function normaliseJoinCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return isValidEventCode(digits) ? digits : null;
}

/**
 * True when `value` is a valid invite token.
 *
 * Delegates to contracts, which means Crockford base32 with the I/L/O folding applied —
 * not a loose "url-safe characters" filter. Getting this wrong in either direction is
 * expensive: too loose and junk burns a join rate-limit slot; too strict and a token
 * transcribed off signage is rejected on the device that could have fixed it.
 */
export function isJoinToken(value: string): boolean {
  return isValidInviteToken(value);
}

/** Build the canonical universal link that goes on the printed QR code. */
export function buildJoinUrl(siteUrl: string, token: string): string {
  return inviteUrl(siteUrl, token);
}

/**
 * Extract a join target from any inbound URL.
 *
 * Returns `null` for URLs that are not join links — OAuth callbacks and the launcher's
 * own `partybooth://` open both land here and must be ignored rather than throwing.
 */
export function parseJoinLink(raw: string): JoinTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  const isCustomScheme = protocol === APP_SCHEME;
  const isWebLink = protocol === "https" || protocol === "http";
  if (!isCustomScheme && !isWebLink) return null;

  // `partybooth://join/<token>` parses with host="join" and pathname="/<token>", whereas
  // `https://site/join/<token>` has an empty-ish host and pathname="/join/<token>".
  // Rebuilding one segment list makes both shapes fall out the same way.
  const segments = [...(isCustomScheme ? [url.host] : []), ...url.pathname.split("/")]
    .map((segment) => decodeURIComponent(segment).trim())
    .filter((segment) => segment.length > 0);

  const joinIndex = segments.findIndex((segment) => segment.toLowerCase() === JOIN_PATH_SEGMENT);
  if (joinIndex === -1) return null;

  const candidate = segments[joinIndex + 1] ?? url.searchParams.get("token") ?? "";
  if (candidate.length === 0) {
    // `/join?code=123456` — the code-entry fallback shared as a plain link.
    const codeParam = url.searchParams.get("code");
    return codeParam ? toTarget(codeParam) : null;
  }

  return toTarget(candidate);
}

/** Only digits and the separators a human might type between them. */
const CODE_LIKE_PATTERN = /^[\d\s-]+$/;

function toTarget(candidate: string): JoinTarget | null {
  // The lenient `normaliseJoinCode` is for hand-typed input only. Applying it to a URL
  // segment would strip the letters out of a token like `a1b2c3d4...` and mistake the
  // leftover digits for a join code, so a segment must already look like a code.
  if (CODE_LIKE_PATTERN.test(candidate)) {
    const code = normaliseJoinCode(candidate);
    if (code) return { kind: "code", code };
  }
  // Return the *normalised* token: the join mutation compares against the stored
  // Crockford form, so folding case and the I/L/O family has to happen before the
  // request leaves the device.
  if (isJoinToken(candidate)) {
    return { kind: "token", token: normalizeInviteToken(candidate) };
  }
  return null;
}
