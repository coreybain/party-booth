import { describe, expect, it } from "vitest";

import {
  canRotateInvite,
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
  displayUrl,
  inviteUrl,
  joinFallbackUrl,
  joinPath,
  isValidEventCode,
  isValidInviteToken,
  normalizeEventCode,
  normalizeInviteToken,
  keepExistingMemberships,
  registerRotation,
  ROTATION_CONSEQUENCES,
  ROTATION_POLICY,
  type RotationAttemptState,
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

/**
 * The join link is the one string that has to agree in five places: the QR
 * matrix, the printed sign, `apps/web`'s `/join/[token]` route, `apps/mobile`'s
 * universal-link claim, and whatever a guest types. Both apps build it from the
 * functions below and neither concatenates its own.
 */
describe("join links", () => {
  const TOKEN = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

  it("builds the route the web app serves", () => {
    expect(joinPath(TOKEN)).toBe(`/join/${TOKEN}`);
  });

  it("normalises whatever spelling of the token it is handed", () => {
    // Crockford base32 exists so these are all the same token: case folds, I/L
    // become 1, O becomes 0, separators vanish.
    expect(joinPath("abcdefghjkmnpqrstvwxyz0123456789")).toBe(`/join/${TOKEN}`);
    expect(joinPath("ABCDEFGH-JKMN PQRS TVWX YZ01 2345 6789")).toBe(`/join/${TOKEN}`);
    expect(joinPath("IBCDEFGHJKMNPQRSTVWXYZO123456789")).toBe(
      "/join/1BCDEFGHJKMNPQRSTVWXYZ0123456789",
    );
  });

  it("gives the same URL for a token typed either way", () => {
    expect(inviteUrl("https://partybooth.example", "abcdefghjkmnpqrstvwxyz0123456789")).toBe(
      inviteUrl("https://partybooth.example", TOKEN),
    );
  });

  it("prints a fallback URL that carries no credential", () => {
    expect(joinFallbackUrl("https://partybooth.example")).toBe("https://partybooth.example/join");
    expect(joinFallbackUrl("https://partybooth.example/")).toBe("https://partybooth.example/join");
    expect(joinFallbackUrl("https://partybooth.example")).not.toContain(TOKEN);
  });

  it("strips the scheme and any trailing slash for signage", () => {
    expect(displayUrl("https://partybooth.example/join")).toBe("partybooth.example/join");
    expect(displayUrl("http://partybooth.example/")).toBe("partybooth.example");
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

/* -------------------------------------------------------------------------- */
/* Rotation budget                                                            */
/* -------------------------------------------------------------------------- */

describe("the invite-rotation budget", () => {
  it("allows the first rotation with no history", () => {
    expect(canRotateInvite(undefined, 1_000)).toEqual({ allowed: true });
  });

  it(`allows ${ROTATION_POLICY.maxPerWindow} inside the window and refuses the next`, () => {
    let state: RotationAttemptState | undefined;
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      expect(canRotateInvite(state, 1_000).allowed, `rotation ${index + 1}`).toBe(true);
      state = registerRotation(state, 1_000);
    }
    const refused = canRotateInvite(state, 1_000);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterMs).toBe(ROTATION_POLICY.windowMs);
  });

  it("reports how long is left, not a fixed number", () => {
    let state: RotationAttemptState | undefined;
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      state = registerRotation(state, 1_000);
    }
    const refused = canRotateInvite(state, 1_000 + 60_000);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterMs).toBe(ROTATION_POLICY.windowMs - 60_000);
  });

  it("starts a fresh window rather than sliding", () => {
    let state: RotationAttemptState | undefined;
    for (let index = 0; index < ROTATION_POLICY.maxPerWindow; index += 1) {
      state = registerRotation(state, 1_000);
    }
    const later = 1_000 + ROTATION_POLICY.windowMs;
    expect(canRotateInvite(state, later).allowed).toBe(true);

    const rolled = registerRotation(state, later);
    // The count restarts and the window is anchored at `now`, which is what
    // keeps the arithmetic legible in an incident.
    expect(rolled).toEqual({ count: 1, windowStartedAt: later, lastRotatedAt: later });
  });
});

/* -------------------------------------------------------------------------- */
/* What rotation does, in words                                               */
/* -------------------------------------------------------------------------- */

describe("rotation consequences", () => {
  /**
   * The console's modal and the app's Host tab both render these. The point of
   * hoisting them was that the two surfaces had drifted into describing the same
   * irreversible action differently, so what is pinned here is the meaning a
   * host relies on, not the prose.
   */
  it("maps each choice to the argument it means", () => {
    expect(keepExistingMemberships("keep")).toBe(true);
    expect(keepExistingMemberships("revoke")).toBe(false);
  });

  it("describes both choices, and says the old code dies in both", () => {
    for (const choice of ["keep", "revoke"] as const) {
      const consequence = ROTATION_CONSEQUENCES[choice];
      expect(consequence.label.length).toBeGreaterThan(0);
      expect(consequence.summary.length).toBeGreaterThan(0);
      expect(consequence.effects.length).toBeGreaterThan(0);
      // Rotation always kills the printed sign. A host who is not told that has
      // not been told the one thing rotation is for.
      expect(consequence.effects.some((effect) => /stop working/i.test(effect))).toBe(true);
    }
  });

  it("promises the revoke path keeps co-hosts and deletes no photos", () => {
    const effects = ROTATION_CONSEQUENCES.revoke.effects.join(" ");
    expect(effects).toMatch(/co-hosts are kept/i);
    expect(effects).toMatch(/nothing is deleted/i);
    // The sweep is not a ban — the backend records it as a sweep so a caught
    // guest can re-join, and the copy has to say so or a host will not dare.
    expect(effects).toMatch(/come back/i);
  });

  it("does not promise the keep path removes anybody", () => {
    const effects = ROTATION_CONSEQUENCES.keep.effects.join(" ");
    expect(effects).not.toMatch(/removed/i);
  });
});
