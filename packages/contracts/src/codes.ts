import { z } from "zod";

/**
 * Join credentials: the six-digit event code guests type, and the high-entropy
 * token behind the QR / universal link.
 *
 * Both generators take an injectable `randomBytes` source so tests are
 * deterministic. The default source is `globalThis.crypto.getRandomValues`,
 * which exists in Convex, Node ≥ 19 and every browser we support. It is
 * **not** guaranteed in a React Native runtime, which is fine: generation is a
 * server-side concern, and clients only ever call the `normalize*` / `isValid*`
 * halves of this module.
 */

/* -------------------------------------------------------------------------- */
/* Randomness                                                                 */
/* -------------------------------------------------------------------------- */

export type RandomBytes = (length: number) => Uint8Array;

export class CryptoUnavailableError extends Error {
  override readonly name = "CryptoUnavailableError";
  constructor() {
    super(
      "No cryptographic random source. globalThis.crypto.getRandomValues is unavailable in this runtime — generate codes and tokens on the server, or pass an explicit randomBytes source.",
    );
  }
}

export const defaultRandomBytes: RandomBytes = (length) => {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new CryptoUnavailableError();
  }
  return webCrypto.getRandomValues(new Uint8Array(length));
};

/**
 * Uniform integer in `[0, max)` by rejection sampling.
 *
 * The naive `bytes[0] % 10` is biased (256 is not a multiple of 10) which would
 * make some six-digit codes measurably more likely than others. For a code that
 * is the only thing standing between a stranger and someone's party photos,
 * that bias is worth ten lines of code to remove.
 */
function randomBelow(max: number, randomBytes: RandomBytes): number {
  if (max <= 0 || max > 256) {
    throw new RangeError(`randomBelow supports 1..256, received ${max}`);
  }
  const limit = Math.floor(256 / max) * max;
  // Bounded in practice: P(reject) < 1/2 per draw, so this terminates fast.
  for (;;) {
    const [byte] = randomBytes(1);
    if (byte === undefined) throw new CryptoUnavailableError();
    if (byte < limit) return byte % max;
  }
}

/**
 * Length-independent equality. Compares digests of equal length in constant
 * time; differing lengths short-circuit (the length of a code is not a secret).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Six-digit codes (event join code, and the OTP code shape)                   */
/* -------------------------------------------------------------------------- */

export const EVENT_CODE_LENGTH = 6;

const EVENT_CODE_PATTERN = /^\d{6}$/;

/**
 * Codes a generator must never emit. They are the first things a bored guest
 * types, and `000000` in particular reads as "unset" in a log. The exclusion
 * costs ~0.01 % of the keyspace.
 */
function isLowEntropyCode(code: string): boolean {
  if (/^(\d)\1{5}$/.test(code)) return true; // 111111
  const digits = [...code].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 9) % 10);
  return ascending || descending;
}

/** Strip the formatting people type: spaces, hyphens, non-breaking spaces. */
export function normalizeEventCode(input: string): string {
  return input.replace(/[\s -]/g, "");
}

export function isValidEventCode(input: string): boolean {
  const normalized = normalizeEventCode(input);
  return EVENT_CODE_PATTERN.test(normalized);
}

export const eventCodeSchema = z
  .string()
  .transform(normalizeEventCode)
  .refine((value) => EVENT_CODE_PATTERN.test(value), {
    error: "Enter the six-digit code from the invite.",
  });

/**
 * Generate a six-digit event code.
 *
 * Uniqueness is a *database* property: the caller must check the candidate
 * against codes already held by joinable events (see `JOINABLE_EVENT_STATES`)
 * and retry. {@link generateUniqueEventCode} wraps that loop.
 */
export function generateEventCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < EVENT_CODE_LENGTH; i += 1) {
      code += String(randomBelow(10, randomBytes));
    }
    if (!isLowEntropyCode(code)) return code;
  }
}

export class CodeGenerationError extends Error {
  override readonly name = "CodeGenerationError";
  constructor(attempts: number) {
    super(
      `Could not find an unused six-digit code after ${attempts} attempts. The joinable-event code space is saturated — widen the code length before the next party.`,
    );
  }
}

/**
 * Generate a code that `isTaken` says is free.
 *
 * `isTaken` is async because the real implementation is a Convex index lookup.
 * With ~10^6 codes and a private beta, a collision is vanishingly unlikely;
 * exhausting the attempts means something is wrong, so it throws loudly rather
 * than returning a duplicate.
 */
export async function generateUniqueEventCode(
  isTaken: (code: string) => Promise<boolean>,
  options: { maxAttempts?: number; randomBytes?: RandomBytes } = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 10;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateEventCode(randomBytes);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new CodeGenerationError(maxAttempts);
}

/**
 * Validate an admin-chosen specific code (admin console: "rotate to a specific
 * value, collision-checked"). Rejects the same low-entropy shapes the generator
 * avoids, so a human cannot hand-pick `123456`.
 */
export type SpecificCodeRejection = "format" | "lowEntropy";

export function validateSpecificEventCode(
  input: string,
): { ok: true; code: string } | { ok: false; reason: SpecificCodeRejection } {
  const code = normalizeEventCode(input);
  if (!EVENT_CODE_PATTERN.test(code)) return { ok: false, reason: "format" };
  if (isLowEntropyCode(code)) return { ok: false, reason: "lowEntropy" };
  return { ok: true, code };
}

/* -------------------------------------------------------------------------- */
/* Invite tokens (QR / universal link)                                        */
/* -------------------------------------------------------------------------- */

/**
 * 20 bytes = 160 bits, rendered as 32 Crockford base32 characters.
 *
 * Crockford rather than base64url because the token appears on printed signage:
 * the alphabet excludes I, L, O and U, so nothing is confusable with 1, 0 or a
 * rude word, and `normalizeInviteToken` can fold the mistakes people still make.
 */
export const INVITE_TOKEN_BYTES = 20;
export const INVITE_TOKEN_LENGTH = 32;

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{32}$/;

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Fold the transcription errors Crockford base32 is designed to tolerate:
 * case, hyphens, and the I/L/O family.
 */
export function normalizeInviteToken(input: string): string {
  return input
    .trim()
    .replace(/[\s -]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function isValidInviteToken(input: string): boolean {
  return INVITE_TOKEN_PATTERN.test(normalizeInviteToken(input));
}

export const inviteTokenSchema = z
  .string()
  .transform(normalizeInviteToken)
  .refine((value) => INVITE_TOKEN_PATTERN.test(value), {
    error: "That invite link is not valid.",
  });

/** A fresh, unguessable invite token. Server-side only. */
export function generateInviteToken(randomBytes: RandomBytes = defaultRandomBytes): string {
  return encodeCrockford(randomBytes(INVITE_TOKEN_BYTES));
}

/**
 * The URL a QR code encodes. Kept here so the web join route, the app's
 * universal-link handler and the printed signage cannot disagree.
 */
export function inviteUrl(siteUrl: string, token: string): string {
  return new URL(`/join/${normalizeInviteToken(token)}`, siteUrl).toString();
}

/* -------------------------------------------------------------------------- */
/* Generic high-entropy secrets (upload grants, one-time links)                */
/* -------------------------------------------------------------------------- */

/**
 * A URL-safe random secret of `bytes` bytes, base32-encoded. Used for
 * single-use upload grants (Sprint 3) and anything else that needs to be
 * unguessable but does not need to be typed by a human.
 */
export function generateSecret(bytes = 32, randomBytes: RandomBytes = defaultRandomBytes): string {
  if (bytes <= 0) throw new RangeError("secret length must be positive");
  return encodeCrockford(randomBytes(bytes));
}
