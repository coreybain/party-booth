import { describe, expect, it } from "vitest";

import {
  authErrorMessage,
  formatCooldown,
  isCompleteJoinCode,
  isCompleteOtp,
  isProbablyEmail,
  normaliseDigits,
  normaliseEmail,
  normaliseJoinCode,
  normaliseOtp,
} from "./otp";

describe("normaliseEmail", () => {
  it("trims and lower-cases", () => {
    expect(normaliseEmail("  Corey@Example.COM ")).toBe("corey@example.com");
  });
});

describe("isProbablyEmail", () => {
  it.each(["a@b.co", "corey.baines+beta@example.co.uk", "  Corey@Example.COM "])(
    "accepts %s",
    (value) => {
      expect(isProbablyEmail(value)).toBe(true);
    },
  );

  it.each(["", "corey", "corey@", "@example.com", "a@b", "a b@c.com", "a@@b.com", "a@.com"])(
    "rejects %s",
    (value) => {
      expect(isProbablyEmail(value)).toBe(false);
    },
  );

  it("rejects an address longer than 254 characters", () => {
    expect(isProbablyEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("normaliseDigits", () => {
  it("keeps digits only", () => {
    expect(normaliseDigits("4a8-2 9x1", 6)).toBe("48291");
  });

  it("clamps to the requested length", () => {
    expect(normaliseDigits("1234567890", 6)).toBe("123456");
  });
});

describe("normaliseOtp / normaliseJoinCode", () => {
  it("copes with a code pasted out of an email", () => {
    expect(normaliseOtp("Your code is 482 913")).toBe("482913");
    expect(normaliseJoinCode("code: 704-118")).toBe("704118");
  });
});

describe("isCompleteOtp / isCompleteJoinCode", () => {
  it("requires exactly six digits", () => {
    expect(isCompleteOtp("482913")).toBe(true);
    expect(isCompleteOtp("48291")).toBe(false);
    expect(isCompleteOtp("4829134")).toBe(false);
    expect(isCompleteOtp("48291a")).toBe(false);
    expect(isCompleteJoinCode("704118")).toBe(true);
    expect(isCompleteJoinCode("")).toBe(false);
  });
});

describe("formatCooldown", () => {
  it.each([
    [60, "1:00"],
    [59, "0:59"],
    [9, "0:09"],
    [0, "0:00"],
    [-5, "0:00"],
    [125, "2:05"],
  ])("formats %d as %s", (seconds, expected) => {
    expect(formatCooldown(seconds)).toBe(expected);
  });

  it("rounds part-seconds up so the button never unlocks early", () => {
    expect(formatCooldown(0.2)).toBe("0:01");
  });
});

describe("authErrorMessage", () => {
  it("explains rate limiting", () => {
    expect(authErrorMessage({ status: 429 })).toMatch(/too many/i);
    expect(authErrorMessage({ code: "TOO_MANY_ATTEMPTS" })).toMatch(/too many/i);
  });

  it("explains an expired code", () => {
    expect(authErrorMessage({ code: "OTP_EXPIRED" })).toMatch(/expired/i);
  });

  it("explains a wrong code", () => {
    expect(authErrorMessage({ code: "INVALID_OTP" })).toMatch(/not right/i);
    expect(authErrorMessage({ status: 401 })).toMatch(/not right/i);
  });

  it("falls back to the provider message", () => {
    expect(authErrorMessage({ message: "Email provider is not configured" })).toBe(
      "Email provider is not configured",
    );
  });

  it("has a last-resort message for junk input", () => {
    expect(authErrorMessage(undefined)).toMatch(/something went wrong/i);
    expect(authErrorMessage(new Error(""))).toMatch(/something went wrong/i);
  });
});
