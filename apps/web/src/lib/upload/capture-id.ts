/**
 * Capture ids, bound to the browser's CSPRNG.
 *
 * The generator, the length, the alphabet and the reasoning all live in
 * `@partybooth/contracts/capture` — one id per photo, reused for every retry,
 * 128 bits so it cannot be guessed — because `apps/mobile` mints them too, and
 * an id space with two implementations is an id space with two shapes. What is
 * left here is the one thing that genuinely differs between the clients: where
 * the random bytes come from.
 *
 * There is deliberately no `Math.random()` fallback. A browser without
 * `crypto.getRandomValues` also has no `crypto.subtle` and therefore cannot
 * checksum the file either, so one clear failure beats two vague ones — see
 * `ChecksumUnavailableError` in `./checksum`.
 */

import {
  CAPTURE_ID_PREFIXES,
  isValidCaptureId,
  newCaptureId as mintCaptureId,
  type RandomBytes,
} from "@/lib/contracts";

export { isValidCaptureId };
export type { RandomBytes };

export const cryptoRandomBytes: RandomBytes = (length: number) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * A new capture id, prefixed `w` for "web".
 *
 * The prefix is for a human reading an audit row at 1 a.m. wondering whether a
 * failing upload came from the app or from mobile web; it carries no meaning to
 * any code, and nothing may ever branch on it.
 */
export function newCaptureId(random: RandomBytes = cryptoRandomBytes): string {
  return mintCaptureId(CAPTURE_ID_PREFIXES.web, random);
}
