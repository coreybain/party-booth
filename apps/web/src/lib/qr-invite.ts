import { isValidInviteToken, normalizeInviteToken } from "@/lib/contracts";

/**
 * Read the bearer token from a PartyBooth QR destination without following it.
 *
 * Signage is built on the canonical production origin, while this scanner can
 * also be opened on a preview deployment. The hostname is therefore deliberately
 * not compared with `window.location`; the strict `/join/<valid token>` shape is
 * the trust boundary, and the caller always navigates on its own origin.
 */
export function inviteTokenFromQr(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  let tokenSegment: string | undefined;

  if (url.protocol === "http:" || url.protocol === "https:") {
    const match = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
    tokenSegment = match?.[1];
  } else if (url.protocol === "partybooth:" && url.hostname === "join") {
    tokenSegment = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }

  if (tokenSegment === undefined) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(tokenSegment);
  } catch {
    return null;
  }

  const token = normalizeInviteToken(decoded);
  return isValidInviteToken(token) ? token : null;
}
