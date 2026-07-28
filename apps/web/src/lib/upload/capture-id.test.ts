import { describe, expect, it } from "vitest";

import { isValidCaptureId, newCaptureId } from "./capture-id";
import { toHex } from "./checksum";

describe("newCaptureId", () => {
  it("produces something Convex will accept", () => {
    // The same `captureIdSchema` the grant mutation parses with: a generator bug
    // has to fail here, not as a validation error on somebody's phone.
    for (let i = 0; i < 50; i += 1) {
      expect(isValidCaptureId(newCaptureId())).toBe(true);
    }
  });

  it("is 33 characters — a prefix and 128 bits of hex", () => {
    expect(newCaptureId()).toHaveLength(33);
  });

  it("uses the randomness it is given", () => {
    const id = newCaptureId(() => new Uint8Array(16).fill(0xab));
    expect(id).toBe(`w${"ab".repeat(16)}`);
  });

  it("pads bytes below 0x10 to two characters", () => {
    // Without the pad the id is short, non-uniform, and occasionally collides.
    const id = newCaptureId(() => Uint8Array.from({ length: 16 }, (_, index) => index));
    expect(id).toBe("w000102030405060708090a0b0c0d0e0f");
    expect(isValidCaptureId(id)).toBe(true);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newCaptureId()));
    expect(ids.size).toBe(500);
  });
});

describe("isValidCaptureId", () => {
  it("rejects what the contract rejects", () => {
    expect(isValidCaptureId("short")).toBe(false);
    expect(isValidCaptureId("has space")).toBe(false);
    expect(isValidCaptureId("a".repeat(65))).toBe(false);
    expect(isValidCaptureId("with-hyphens_and_underscores")).toBe(true);
  });
});

describe("toHex", () => {
  it("is 64 lower-case characters for a SHA-256 digest", () => {
    const hex = toHex(new Uint8Array(32).fill(0xff));
    expect(hex).toBe("f".repeat(64));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pads every byte", () => {
    expect(toHex(Uint8Array.from([0, 1, 15, 16]))).toBe("00010f10");
  });
});
