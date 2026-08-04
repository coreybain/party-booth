/**
 * Resolving the origin a join link is built on.
 *
 * The *shape* of a join link is not decided here — `@partybooth/contracts/codes`
 * owns `joinPath`, `inviteUrl` and `joinFallbackUrl`, because the same strings
 * have to satisfy the app's universal-link claim and the printed signage as
 * well as this app's routes. What is genuinely local to `apps/web` is the one
 * question contracts cannot answer: *which* origin.
 *
 * It comes from `NEXT_PUBLIC_SITE_URL` in preference to `window.location.origin`
 * because a Vercel preview deployment must still print the **production** URL —
 * a preview host is not in the apps' associated domains, so a QR built on it
 * would open in a browser instead of the app.
 */

import {
  displayUrl,
  inviteUrl,
  joinFallbackUrl as buildJoinFallbackUrl,
  joinPath,
  normalizeInviteToken,
  isValidInviteToken,
} from "./contracts";
import { siteUrl } from "./backend";

/**
 * The canonical origin for links that leave this app — QR codes, printed
 * signage, anything a guest types.
 *
 * `undefined` when nothing is configured and there is no browser to ask, which
 * is the offline/preview case: callers render the path or the six-digit code
 * instead of a broken absolute URL.
 */
export function canonicalOrigin(): string | undefined {
  if (siteUrl !== undefined) return stripTrailingSlash(siteUrl);
  if (typeof window !== "undefined") return stripTrailingSlash(window.location.origin);
  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The absolute join URL for a token, or `undefined` when there is no origin to
 * build it from.
 */
export function joinUrl(token: string, origin = canonicalOrigin()): string | undefined {
  return origin === undefined ? undefined : inviteUrl(origin, token);
}

/**
 * Open an invite in the installed PartyBooth app.
 *
 * The HTTPS invite remains the QR's durable destination. This custom-scheme
 * version is only for an explicit "open the app" action once the guest is
 * already looking at the browser fallback.
 */
export function mobileJoinUrl(token: string): string {
  return `partybooth://join/${normalizeInviteToken(token)}`;
}

/** The absolute code-entry URL, or `undefined` when there is no origin. */
export function joinFallbackUrl(origin = canonicalOrigin()): string | undefined {
  return origin === undefined ? undefined : buildJoinFallbackUrl(origin);
}

/** Re-exported so callers reach the shared builders through this one seam. */
export { displayUrl, isValidInviteToken, joinPath, normalizeInviteToken };
