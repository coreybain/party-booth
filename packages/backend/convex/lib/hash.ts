/**
 * SHA-256, hex-encoded.
 *
 * Convex's runtime provides the Web Crypto API (`crypto.subtle`), so there is
 * no Node dependency here and this works identically in the deployment and in
 * the `edge-runtime` test environment.
 *
 * Two callers, both storing something they must be able to *compare* but must
 * not be able to *read back*: the six-digit code behind an email verification,
 * and the network key behind a join throttle row. A digest of an IP is enough
 * to count attempts from it and not enough to be a log of who was where.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * Both are the same length by construction, so this really is constant-time for
 * the inputs it sees. `@partybooth/contracts` has the same primitive; it is
 * re-exported rather than reimplemented.
 */
export { constantTimeEqual } from "@partybooth/contracts";
