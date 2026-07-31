import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex" },
  digestStringAsync: vi.fn(),
  getRandomBytesAsync: vi.fn(),
}));

import { createAppleNonce, nonceBytesToHex } from "./apple-nonce";

describe("native Apple nonce material", () => {
  it("hex-encodes bytes without dropping leading zeroes", () => {
    expect(nonceBytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  it("uses 32 random bytes and hashes the raw value exactly once", async () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 7;
    bytes[31] = 255;
    const source = {
      randomBytes: vi.fn().mockResolvedValue(bytes),
      sha256Hex: vi.fn().mockResolvedValue("hashed-for-apple"),
    };

    const result = await createAppleNonce(source);

    expect(source.randomBytes).toHaveBeenCalledWith(32);
    expect(result.raw).toHaveLength(64);
    expect(source.sha256Hex).toHaveBeenCalledWith(result.raw);
    expect(result).toEqual({ raw: result.raw, sha256: "hashed-for-apple" });
  });
});
