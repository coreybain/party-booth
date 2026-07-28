/**
 * SHA-256 of the exact bytes about to be sent, lower-case hex.
 *
 * The checksum is what binds a grant to a body. Convex mints the grant against
 * this value, and `matchesGrant` refuses a completion whose checksum disagrees —
 * so it has to be computed over the **derivative**, after re-encoding, not over
 * whatever the camera handed us. Hashing the wrong artefact produces a grant
 * nothing can ever satisfy.
 *
 * `crypto.subtle` needs a secure context. That is not a constraint in practice:
 * the guest path is a QR code pointing at an HTTPS universal link, and
 * `localhost` counts as secure — but the failure has to be a clear sentence
 * rather than "cannot read properties of undefined", because the one place it
 * will happen is somebody testing on `http://192.168.1.x:3000` from a phone the
 * night before the party.
 */

import { toHex } from "@/lib/contracts";

export class ChecksumUnavailableError extends Error {
  override readonly name = "ChecksumUnavailableError";
  constructor() {
    super(
      "This page needs a secure connection (https) to prepare a photo for upload. " +
        "Open it over https, or use the printed QR link.",
    );
  }
}

/** Lower-case hex SHA-256, matching `checksumSchema` in `@partybooth/contracts`. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new ChecksumUnavailableError();

  const digest = await subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

export async function checksumOfBlob(blob: Blob): Promise<string> {
  return await sha256Hex(await blob.arrayBuffer());
}

/**
 * Re-exported so callers have one import for the checksum path. The encoding
 * itself is `@partybooth/contracts/capture`'s — `apps/mobile` hashes with
 * `expo-crypto` and has to produce byte-identical output, because the value is
 * what `matchesGrant` compares a completion against.
 */
export { toHex };
