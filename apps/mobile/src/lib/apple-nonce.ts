/**
 * Nonce material for native Sign in with Apple.
 *
 * Apple receives the SHA-256 digest and writes that digest into the identity
 * token. Better Auth receives the original value and hashes it while verifying
 * the token. Keeping the two names explicit prevents accidentally sending the
 * digest to both sides, which would make the server compare a double hash.
 */

import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytesAsync,
} from "expo-crypto";

export interface AppleNonce {
  readonly raw: string;
  readonly sha256: string;
}

export interface AppleNonceSource {
  readonly randomBytes: (length: number) => Promise<Uint8Array>;
  readonly sha256Hex: (value: string) => Promise<string>;
}

const expoNonceSource: AppleNonceSource = {
  randomBytes: getRandomBytesAsync,
  sha256Hex: (value) =>
    digestStringAsync(CryptoDigestAlgorithm.SHA256, value, {
      encoding: CryptoEncoding.HEX,
    }),
};

/** Hex is URL/header safe and preserves every bit of the 32 random bytes. */
export function nonceBytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Create 256 bits of nonce entropy and the digest Apple expects. */
export async function createAppleNonce(
  source: AppleNonceSource = expoNonceSource,
): Promise<AppleNonce> {
  const raw = nonceBytesToHex(await source.randomBytes(32));
  return { raw, sha256: await source.sha256Hex(raw) };
}
