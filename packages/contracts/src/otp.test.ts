import { describe, expect, it } from "vitest";

import { isValidEventCode } from "./codes";
import {
  canSendOtp,
  createOtpChallenge,
  generateOtpCode,
  isOtpExpired,
  isOtpLockedOut,
  OTP_FAILURE_MESSAGES,
  OTP_POLICY,
  otpAttemptsRemaining,
  otpCodeSchema,
  otpExpiresAt,
  registerOtpSend,
  verifyOtp,
  type OtpChallengeState,
} from "./otp";

const T0 = 1_800_000_000_000; // fixed clock; nothing here reads Date.now()
const MINUTE = 60_000;

describe("OTP_POLICY", () => {
  it("matches the numbers in PLAN.md", () => {
    expect(OTP_POLICY.codeLength).toBe(6);
    expect(OTP_POLICY.ttlMs).toBe(10 * MINUTE);
    expect(OTP_POLICY.maxAttempts).toBe(5);
    expect(OTP_POLICY.resendCooldownMs).toBe(MINUTE);
  });
});

describe("expiry", () => {
  it("expires exactly ten minutes after issue", () => {
    expect(otpExpiresAt(T0)).toBe(T0 + 10 * MINUTE);
  });

  it("is usable up to the last millisecond and dead on the boundary", () => {
    const state = createOtpChallenge(T0);
    expect(isOtpExpired(state, T0)).toBe(false);
    expect(isOtpExpired(state, T0 + 10 * MINUTE - 1)).toBe(false);
    expect(isOtpExpired(state, T0 + 10 * MINUTE)).toBe(true);
    expect(isOtpExpired(state, T0 + 60 * MINUTE)).toBe(true);
  });

  it("refuses a correct code once it has expired", () => {
    const state = createOtpChallenge(T0);
    const result = verifyOtp(state, "482913", "482913", T0 + 10 * MINUTE);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("expired");
  });
});

describe("attempts", () => {
  it("burns one attempt per wrong guess and locks out on the fifth", () => {
    let state: OtpChallengeState = createOtpChallenge(T0);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = verifyOtp(state, "000000", "482913", T0 + 1000);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("mismatch");
      expect(result.ok === false && result.attemptsRemaining).toBe(5 - attempt);
      state = (result.ok === false && result.state) as OtpChallengeState;
    }

    const fifth = verifyOtp(state, "000000", "482913", T0 + 1000);
    expect(fifth.ok).toBe(false);
    expect(fifth.ok === false && fifth.reason).toBe("lockedOut");
    expect(fifth.ok === false && fifth.attemptsRemaining).toBe(0);

    const locked = (fifth.ok === false && fifth.state) as OtpChallengeState;
    expect(isOtpLockedOut(locked)).toBe(true);
    expect(otpAttemptsRemaining(locked)).toBe(0);
  });

  it("refuses the correct code once locked out", () => {
    const locked: OtpChallengeState = { ...createOtpChallenge(T0), attempts: 5 };
    const result = verifyOtp(locked, "482913", "482913", T0 + 1000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("lockedOut");
  });

  it("burns an attempt on malformed input, so garbage cannot probe for free", () => {
    const state = createOtpChallenge(T0);
    const result = verifyOtp(state, "", "482913", T0 + 1000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.attemptsRemaining).toBe(4);
  });

  it("accepts the right code and marks it consumed", () => {
    const state = createOtpChallenge(T0);
    const result = verifyOtp(state, "482913", "482913", T0 + 1000);
    expect(result.ok).toBe(true);
    expect(result.ok && result.state.consumedAt).toBe(T0 + 1000);
  });

  it("is strictly single-use", () => {
    const first = verifyOtp(createOtpChallenge(T0), "482913", "482913", T0 + 1000);
    expect(first.ok).toBe(true);
    const replay = verifyOtp(
      (first.ok && first.state) as OtpChallengeState,
      "482913",
      "482913",
      T0 + 2000,
    );
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.reason).toBe("consumed");
  });

  it("does not leak whether an address exists", () => {
    const result = verifyOtp(undefined, "482913", "482913", T0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("notFound");
    // The copy shown to the user is identical to the expired case.
    expect(OTP_FAILURE_MESSAGES.notFound).toBe(OTP_FAILURE_MESSAGES.expired);
  });

  it("never returns a mutated input state", () => {
    const state = createOtpChallenge(T0);
    verifyOtp(state, "000000", "482913", T0 + 1000);
    expect(state.attempts).toBe(0);
    expect(state.consumedAt).toBeUndefined();
  });
});

describe("resend cooldown", () => {
  it("blocks a resend inside sixty seconds and reports the wait", () => {
    const state = createOtpChallenge(T0);
    const decision = canSendOtp(state, T0 + 30_000);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("cooldown");
    expect(decision.allowed === false && decision.retryAfterMs).toBe(30_000);
  });

  it("allows a resend on the sixty-second boundary", () => {
    const state = createOtpChallenge(T0);
    expect(canSendOtp(state, T0 + MINUTE).allowed).toBe(true);
    expect(canSendOtp(state, T0 + MINUTE - 1).allowed).toBe(false);
  });

  it("always allows the very first send", () => {
    expect(canSendOtp(undefined, T0).allowed).toBe(true);
  });

  it("resets the attempt counter but not the send counter on resend", () => {
    const first = createOtpChallenge(T0);
    const burned: OtpChallengeState = { ...first, attempts: 3 };
    const next = registerOtpSend(burned, T0 + MINUTE);
    expect(next.attempts).toBe(0);
    expect(next.sendCount).toBe(2);
    expect(next.issuedAt).toBe(T0 + MINUTE);
    expect(next.expiresAt).toBe(T0 + MINUTE + OTP_POLICY.ttlMs);
    expect(next.consumedAt).toBeUndefined();
  });
});

describe("send ceiling (enumeration protection)", () => {
  it("stops after five sends in the window even if each waits out the cooldown", () => {
    let state = createOtpChallenge(T0);
    let now = T0;
    for (let send = 2; send <= OTP_POLICY.maxSendsPerWindow; send += 1) {
      now += 2 * MINUTE;
      expect(canSendOtp(state, now).allowed, `send #${send} should be allowed`).toBe(true);
      state = registerOtpSend(state, now);
    }
    expect(state.sendCount).toBe(OTP_POLICY.maxSendsPerWindow);

    now += 2 * MINUTE;
    const blocked = canSendOtp(state, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.reason).toBe("rateLimited");
    expect(blocked.allowed === false && blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("opens a fresh window an hour later", () => {
    const saturated: OtpChallengeState = {
      ...createOtpChallenge(T0),
      sendCount: OTP_POLICY.maxSendsPerWindow,
    };
    expect(canSendOtp(saturated, T0 + OTP_POLICY.sendWindowMs).allowed).toBe(true);
    const next = registerOtpSend(saturated, T0 + OTP_POLICY.sendWindowMs);
    expect(next.sendCount).toBe(1);
    expect(next.windowStartedAt).toBe(T0 + OTP_POLICY.sendWindowMs);
  });

  it("prefers the rate-limit reason over the cooldown reason", () => {
    const saturated: OtpChallengeState = {
      ...createOtpChallenge(T0),
      sendCount: OTP_POLICY.maxSendsPerWindow,
    };
    const decision = canSendOtp(saturated, T0 + 1000);
    expect(decision.allowed === false && decision.reason).toBe("rateLimited");
  });
});

describe("otpCodeSchema / generateOtpCode", () => {
  it("normalises what people paste out of an email", () => {
    expect(otpCodeSchema.parse("482 913")).toBe("482913");
    expect(otpCodeSchema.parse("482-913")).toBe("482913");
    expect(otpCodeSchema.safeParse("48291").success).toBe(false);
    expect(otpCodeSchema.safeParse("abcdef").success).toBe(false);
  });

  it("generates six-digit codes", () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_POLICY.codeLength);
      expect(isValidEventCode(code)).toBe(true);
    }
  });
});
