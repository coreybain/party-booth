import { describe, expect, it, vi } from "vitest";

import {
  emailOtpErrorMessage,
  formatOtpCooldown,
  readEmailInput,
  readOtpInput,
  sendEmailSignInCode,
  signInWithEmailCode,
} from "./email-otp";

describe("email OTP input", () => {
  it("normalises email with the shared backend contract", () => {
    expect(readEmailInput("  REVIEWER@Example.COM  ", true)).toEqual({
      value: "reviewer@example.com",
      valid: true,
    });
    expect(readEmailInput("not-an-email", true)).toMatchObject({ valid: false });
  });

  it("accepts pasted separators and caps the shared six-digit length", () => {
    expect(readOtpInput("12 34-567")).toEqual({ digits: "123456", complete: true });
    expect(readOtpInput("12", true)).toMatchObject({ digits: "12", complete: false });
  });

  it("formats a clamped resend countdown", () => {
    expect(formatOtpCooldown(65)).toBe("1:05");
    expect(formatOtpCooldown(-4)).toBe("0:00");
  });
});

describe("Better Auth email OTP transport", () => {
  it("uses the real sign-in challenge and verification endpoints", async () => {
    const sendVerificationOtp = vi.fn().mockResolvedValue({ error: null });
    const emailOtp = vi.fn().mockResolvedValue({ error: null });
    const client = { emailOtp: { sendVerificationOtp }, signIn: { emailOtp } };

    await expect(sendEmailSignInCode(client, "reviewer@example.com")).resolves.toEqual({
      status: "ok",
    });
    await expect(signInWithEmailCode(client, "reviewer@example.com", "123456")).resolves.toEqual({
      status: "ok",
    });
    expect(sendVerificationOtp).toHaveBeenCalledWith({
      email: "reviewer@example.com",
      type: "sign-in",
    });
    expect(emailOtp).toHaveBeenCalledWith({ email: "reviewer@example.com", otp: "123456" });
  });

  it("turns structured provider failures and thrown network failures into safe copy", async () => {
    const rateLimited = {
      emailOtp: { sendVerificationOtp: vi.fn().mockResolvedValue({ error: { status: 429 } }) },
      signIn: { emailOtp: vi.fn() },
    };
    await expect(sendEmailSignInCode(rateLimited, "a@example.com")).resolves.toEqual({
      status: "error",
      message: "Too many attempts. Wait a few seconds and try again.",
    });

    expect(emailOtpErrorMessage({ code: "OTP_EXPIRED" })).toMatch(/expired/i);
    expect(emailOtpErrorMessage({ code: "INVALID_OTP" })).toMatch(/not right/i);
  });
});
