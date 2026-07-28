/**
 * The second throttle axis for joins, derived on the server.
 *
 * `join.join` and `join.previewByCode` are throttled per account *and*, when one
 * is supplied, per network. The account key always exists because joining is
 * authenticated — but accounts are free and self-serve (Google sign-in or an
 * email OTP), so an account-only ceiling is "ten guesses per fifteen minutes per
 * disposable inbox", which against a keyspace of 10^6 is not a ceiling at all.
 *
 * A Convex mutation called over the WebSocket has no client address, so the
 * second axis cannot come from the browser: anything the browser sends is a
 * value the attacker chooses. It has to be derived by something that sits in the
 * request path, which is why `POST /api/join` exists (`app/api/join/route.ts`)
 * and why the browser no longer calls the Convex join mutations directly.
 *
 * The value is passed to Convex opaquely and hashed there, so no throttle row
 * ever holds an address. This module only picks which header to believe.
 *
 * Pure and header-only, so the choice is unit-tested rather than reasoned about.
 */

/**
 * Headers that carry a client address, in order of how much they can be
 * trusted **in this deployment**.
 *
 * `x-forwarded-for` is set by Vercel's edge on every request and any value the
 * client sent is replaced, not appended — which is the only reason reading it is
 * safe. Behind a different proxy this order is the thing to re-check: a header a
 * client can forge is a header an attacker uses to shed the key.
 */
const ADDRESS_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

/**
 * The first hop in an `x-forwarded-for` chain is the client; everything after it
 * is proxies. Taking the last one instead is the classic mistake — it keys every
 * visitor to the same edge node and turns the throttle into an outage.
 */
function firstHop(value: string): string {
  return (value.split(",")[0] ?? "").trim();
}

/** Reject shapes that are obviously not addresses, so junk cannot create keys. */
function looksLikeAddress(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  // IPv4, IPv6, or an IPv4-mapped IPv6 address. Deliberately loose: this is a
  // sanity check on a value we hash, not a parser.
  return /^[0-9a-fA-F:.%[\]]+$/.test(value) && /[0-9a-fA-F]/.test(value);
}

/**
 * The network throttle key for this request, or `undefined` when the runtime
 * gave us nothing usable.
 *
 * `undefined` means the attempt is charged to the account key alone — the same
 * behaviour as before this existed. It never *removes* a key, which is what
 * makes a best-effort derivation safe.
 */
export function clientNetworkKey(headers: Headers): string | undefined {
  for (const header of ADDRESS_HEADERS) {
    const raw = headers.get(header);
    if (!raw) continue;
    const candidate = firstHop(raw);
    if (looksLikeAddress(candidate)) return candidate;
  }
  return undefined;
}
