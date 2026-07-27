import { describe, expect, it } from "vitest";

import {
  CodeGenerationError,
  constantTimeEqual,
  CryptoUnavailableError,
  EVENT_CODE_LENGTH,
  eventCodeSchema,
  generateEventCode,
  generateInviteToken,
  generateSecret,
  generateUniqueEventCode,
  INVITE_TOKEN_LENGTH,
  inviteTokenSchema,
  inviteUrl,
  isValidEventCode,
  isValidInviteToken,
  normalizeEventCode,
  normalizeInviteToken,
  validateSpecificEventCode,
  type RandomBytes,
} from "./codes";

/** Deterministic byte source: hands out the scripted bytes, then cycles. */
function scriptedBytes(script: readonly number[]): RandomBytes {
  let index = 0;
  return (length) =>
    Uint8Array.from({ length }, () => {
      const byte = script[index % script.length] ?? 0;
      index += 1;
      return byte;
    });
}

describe("normalizeEventCode / isValidEventCode", () => {
  it("strips the formatting people type", () => {
    expect(normalizeEventCode("482 913")).toBe("482913");
    expect(normalizeEventCode("482-913")).toBe("482913");
    expect(normalizeEventCode(" 482913 ")).toBe("482913");
  });

  it("accepts a leading zero", () => {
    expect(isValidEventCode("012345")).toBe(true);
  });

  it.each(["12345", "1234567", "12345a", "", "abcdef"])("rejects %o", (input) => {
    expect(isValidEventCode(input)).toBe(false);
  });

  it("parses through the zod schema, normalising as it goes", () => {
    expect(eventCodeSchema.parse("48 29-13")).toBe("482913");
    expect(eventCodeSchema.safeParse("48291").success).toBe(false);
  });
});

describe("generateEventCode", () => {
  it("produces exactly six digits", () => {
    const code = generateEventCode(scriptedBytes([4, 8, 2, 9, 1, 3]));
    expect(code).toBe("482913");
    expect(code).toHaveLength(EVENT_CODE_LENGTH);
  });

  it("discards the bytes that would bias a digit", () => {
    // 250..255 must be rejected: 256 is not a multiple of 10, so keeping them
    // would make 0..5 more likely than 6..9.
    expect(generateEventCode(scriptedBytes([250, 3, 251, 6, 255, 1, 9, 4]))).toBe("361943");
  });

  it("never emits an all-same-digit code", () => {
    // First round would be 111111; the generator must discard and try again.
    expect(generateEventCode(scriptedBytes([1, 1, 1, 1, 1, 1, 4, 0, 7, 2, 9, 5]))).toBe("407295");
  });

  it("never emits a straight run", () => {
    expect(generateEventCode(scriptedBytes([1, 2, 3, 4, 5, 6, 9, 0, 4, 4, 2, 8]))).toBe("904428");
    expect(generateEventCode(scriptedBytes([6, 5, 4, 3, 2, 1, 9, 0, 4, 4, 2, 8]))).toBe("904428");
  });

  it("produces well-formed codes with real randomness", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateEventCode();
      expect(isValidEventCode(code)).toBe(true);
      expect(validateSpecificEventCode(code).ok).toBe(true);
    }
  });

  it("is not biased towards low digits", () => {
    // A modulo-256 implementation would over-produce 0..5. Check the tail digit
    // distribution is not wildly skewed over a decent sample.
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 5000; i += 1) {
      const last = Number(generateEventCode().at(-1));
      counts[last] = (counts[last] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(300);
      expect(count).toBeLessThan(700);
    }
  });

  it("surfaces a clear error when the runtime has no crypto", () => {
    const noCrypto: RandomBytes = () => {
      throw new CryptoUnavailableError();
    };
    expect(() => generateEventCode(noCrypto)).toThrow(CryptoUnavailableError);
    expect(() => generateEventCode(noCrypto)).toThrow(/server/i);
  });
});

describe("generateUniqueEventCode", () => {
  it("retries past a collision", async () => {
    const taken = new Set(["407295"]);
    const code = await generateUniqueEventCode(async (candidate) => taken.has(candidate), {
      randomBytes: scriptedBytes([4, 0, 7, 2, 9, 5, 1, 3, 8, 6, 2, 4]),
    });
    expect(code).toBe("138624");
  });

  it("throws rather than returning a duplicate when the space is saturated", async () => {
    await expect(generateUniqueEventCode(async () => true, { maxAttempts: 3 })).rejects.toThrow(
      CodeGenerationError,
    );
  });
});

describe("validateSpecificEventCode", () => {
  it("accepts a well-formed code", () => {
    expect(validateSpecificEventCode("40 72-95")).toEqual({ ok: true, code: "407295" });
  });

  it("rejects a badly formed one", () => {
    expect(validateSpecificEventCode("4072")).toEqual({ ok: false, reason: "format" });
  });

  it("stops an admin hand-picking a guessable code", () => {
    expect(validateSpecificEventCode("123456")).toEqual({ ok: false, reason: "lowEntropy" });
    expect(validateSpecificEventCode("000000")).toEqual({ ok: false, reason: "lowEntropy" });
    expect(validateSpecificEventCode("987654")).toEqual({ ok: false, reason: "lowEntropy" });
  });
});

describe("invite tokens", () => {
  it("is 32 Crockford characters from 20 bytes", () => {
    const token = generateInviteToken(scriptedBytes([0]));
    expect(token).toBe("0".repeat(INVITE_TOKEN_LENGTH));
  });

  it("uses an alphabet with no confusable characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const token = generateInviteToken();
      expect(token).toHaveLength(INVITE_TOKEN_LENGTH);
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
      expect(token).not.toMatch(/[ILOU]/);
      expect(isValidInviteToken(token)).toBe(true);
    }
  });

  it("does not repeat itself", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateInviteToken()));
    expect(tokens.size).toBe(500);
  });

  it("forgives the transcription mistakes the alphabet is designed for", () => {
    const token = generateInviteToken();
    const mangled = token.toLowerCase();
    expect(normalizeInviteToken(mangled)).toBe(token);
    expect(normalizeInviteToken("o1l0-abcd")).toBe("0110ABCD");
  });

  it("rejects anything of the wrong length or alphabet", () => {
    expect(isValidInviteToken("")).toBe(false);
    expect(isValidInviteToken("0".repeat(31))).toBe(false);
    expect(isValidInviteToken("0".repeat(33))).toBe(false);
    expect(isValidInviteToken(`${"0".repeat(31)}!`)).toBe(false);
  });

  it("parses through the zod schema", () => {
    const token = generateInviteToken();
    expect(inviteTokenSchema.parse(token.toLowerCase())).toBe(token);
    expect(inviteTokenSchema.safeParse("nope").success).toBe(false);
  });

  it("builds the join URL the QR code and the app both use", () => {
    const token = generateInviteToken(scriptedBytes([0]));
    expect(inviteUrl("https://partybooth.example", token)).toBe(
      `https://partybooth.example/join/${token}`,
    );
    // A site URL with a trailing path should not swallow the join route.
    expect(inviteUrl("https://partybooth.example/", token)).toBe(
      `https://partybooth.example/join/${token}`,
    );
  });
});

describe("generateSecret", () => {
  it("scales with the requested byte count", () => {
    expect(generateSecret(32, scriptedBytes([0]))).toHaveLength(Math.ceil((32 * 8) / 5));
    expect(generateSecret(16, scriptedBytes([0]))).toHaveLength(Math.ceil((16 * 8) / 5));
  });

  it("refuses a zero-length secret", () => {
    expect(() => generateSecret(0)).toThrow(RangeError);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("482913", "482913")).toBe(true);
  });

  it("rejects differences at any position", () => {
    expect(constantTimeEqual("482913", "482914")).toBe(false);
    expect(constantTimeEqual("482913", "582913")).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(constantTimeEqual("482913", "48291")).toBe(false);
    expect(constantTimeEqual("", "0")).toBe(false);
  });
});
