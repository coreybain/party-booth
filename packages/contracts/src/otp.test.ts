import { describe, expect, it } from "vitest";

import { isValidEventCode } from "./codes";
import {
  canSendOtp,
  createOtpSendState,
  generateOtpCode,
  OTP_POLICY,
  OTP_SEND_DENIAL_MESSAGES,
  otpCodeSchema,
  registerOtpSend,
  type OtpSendState,
} from "./otp";

const T0 = 1_800_000_000_000; // fixed clock; nothing here reads Date.now()
const MINUTE = 60_000;

describe("OTP_POLICY", () => {
  it("matches the numbers in PLAN.md", () => {
    expect(OTP_POLICY.codeLength).toBe(6);
    expect(OTP_POLICY.ttlMs).toBe(10 * MINUTE);
    expect(OTP_POLICY.maxAttempts).toBe(5);
    expect(OTP_POLICY.resendCooldownMs).toBe(MINUTE);
    expect(OTP_POLICY.maxSendsPerWindow).toBe(5);
    expect(OTP_POLICY.sendWindowMs).toBe(60 * MINUTE);
  });
});

describe("resend cooldown", () => {
  it("blocks a resend inside sixty seconds and reports the wait", () => {
    const decision = canSendOtp(createOtpSendState(T0), T0 + 30_000);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("cooldown");
    expect(decision.allowed === false && decision.retryAfterMs).toBe(30_000);
  });

  it("allows a resend on the sixty-second boundary", () => {
    const state = createOtpSendState(T0);
    expect(canSendOtp(state, T0 + MINUTE).allowed).toBe(true);
    expect(canSendOtp(state, T0 + MINUTE - 1).allowed).toBe(false);
  });

  it("always allows the very first send", () => {
    expect(canSendOtp(undefined, T0).allowed).toBe(true);
  });

  it("counts a resend against the window", () => {
    const next = registerOtpSend(createOtpSendState(T0), T0 + MINUTE);
    expect(next.sendCount).toBe(2);
    expect(next.lastSentAt).toBe(T0 + MINUTE);
    expect(next.windowStartedAt).toBe(T0);
  });

  it("never mutates the state it was given", () => {
    const state = createOtpSendState(T0);
    registerOtpSend(state, T0 + MINUTE);
    expect(state).toEqual({ lastSentAt: T0, sendCount: 1, windowStartedAt: T0 });
  });
});

describe("send ceiling (enumeration protection)", () => {
  it("stops after five sends in the window even if each waits out the cooldown", () => {
    let state = createOtpSendState(T0);
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
    const saturated: OtpSendState = {
      ...createOtpSendState(T0),
      sendCount: OTP_POLICY.maxSendsPerWindow,
    };
    expect(canSendOtp(saturated, T0 + OTP_POLICY.sendWindowMs).allowed).toBe(true);
    const next = registerOtpSend(saturated, T0 + OTP_POLICY.sendWindowMs);
    expect(next.sendCount).toBe(1);
    expect(next.windowStartedAt).toBe(T0 + OTP_POLICY.sendWindowMs);
  });

  it("prefers the rate-limit reason over the cooldown reason", () => {
    const saturated: OtpSendState = {
      ...createOtpSendState(T0),
      sendCount: OTP_POLICY.maxSendsPerWindow,
    };
    expect(canSendOtp(saturated, T0 + 1000).allowed === false).toBe(true);
    const decision = canSendOtp(saturated, T0 + 1000);
    expect(decision.allowed === false && decision.reason).toBe("rateLimited");
  });

  it("has copy for both denials that says nothing about whether the address exists", () => {
    for (const message of Object.values(OTP_SEND_DENIAL_MESSAGES)) {
      expect(message).not.toMatch(/account|registered|unknown|exists/i);
    }
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
