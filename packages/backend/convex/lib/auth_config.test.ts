import { OTP_POLICY } from "@partybooth/contracts";
import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adminEmailAllowlist,
  authBaseUrl,
  demoLogin,
  isAdminEmail,
  isDemoLogin,
  resetConfigWarnings,
  siteUrl,
  trustedOrigins,
} from "./config";
import { emailOtpPolicyOptions, otpPurposeFor } from "./otp";
import {
  appleBundleIdentifier,
  availableSignInMethods,
  isAppleConfigured,
  isGoogleConfigured,
  socialProviderConfig,
} from "./providers";

const KEYS = [
  "SITE_URL",
  "BETTER_AUTH_URL",
  "CONVEX_SITE_URL",
  "ADMIN_EMAIL_ALLOWLIST",
  "DEMO_LOGIN_EMAIL",
  "DEMO_LOGIN_OTP",
  "DEMO_LOGIN_EXPIRES_AT",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "APPLE_CLIENT_ID",
  "APPLE_APP_BUNDLE_IDENTIFIER",
] as const;

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache(serverEnv);
}

function clearEnv(): void {
  setEnv(Object.fromEntries(KEYS.map((key) => [key, undefined])));
}

beforeEach(() => {
  resetConfigWarnings();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* OTP policy handed to Better Auth                                            */
/* -------------------------------------------------------------------------- */

describe("emailOtpPolicyOptions", () => {
  it("hands Better Auth exactly the numbers from PLAN.md", () => {
    const options = emailOtpPolicyOptions();
    expect(options.otpLength).toBe(6);
    // Better Auth counts in seconds; the contract is in milliseconds.
    expect(options.expiresIn).toBe(600);
    expect(options.allowedAttempts).toBe(5);
    expect(options.rateLimit).toEqual({ window: 60, max: 1 });
  });

  it("stays derived from the contract rather than hard-coded", () => {
    const options = emailOtpPolicyOptions();
    expect(options.otpLength).toBe(OTP_POLICY.codeLength);
    expect(options.expiresIn).toBe(OTP_POLICY.ttlMs / 1000);
    expect(options.allowedAttempts).toBe(OTP_POLICY.maxAttempts);
    expect(options.rateLimit?.window).toBe(OTP_POLICY.resendCooldownMs / 1000);
  });

  it("never stores a usable code at rest", () => {
    expect(emailOtpPolicyOptions().storeOTP).toBe("hashed");
  });

  it("generates six-digit codes through our own generator", () => {
    const generate = emailOtpPolicyOptions().generateOTP;
    expect(generate).toBeTypeOf("function");
    for (let i = 0; i < 50; i += 1) {
      const code = generate?.({ email: "a@b.test", type: "sign-in" });
      expect(code).toMatch(/^\d{6}$/);
      // The guessable shapes a five-attempt budget would reward.
      expect(code).not.toBe("123456");
      expect(code).not.toBe("000000");
    }
  });
});

describe("otpPurposeFor", () => {
  it("treats an allowlisted address as an admin sign-in", () => {
    setEnv({ ADMIN_EMAIL_ALLOWLIST: "admin@partybooth.test" });
    expect(otpPurposeFor("sign-in", "admin@partybooth.test")).toBe("adminSignIn");
    expect(otpPurposeFor("sign-in", "someone@partybooth.test")).toBe("organiserSignIn");
  });

  it("maps every non-sign-in type to verification", () => {
    for (const type of ["email-verification", "forget-password", "change-email"] as const) {
      expect(otpPurposeFor(type, "a@b.test")).toBe("emailVerification");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Admin allowlist                                                             */
/* -------------------------------------------------------------------------- */

describe("admin allowlist", () => {
  it("is empty — and therefore closed — when unset", () => {
    clearEnv();
    expect(adminEmailAllowlist()).toEqual([]);
    expect(isAdminEmail("anyone@partybooth.test")).toBe(false);
  });

  it("parses a comma-separated list, case- and space-insensitively", () => {
    setEnv({ ADMIN_EMAIL_ALLOWLIST: " Corey@Example.com , second@example.com " });
    expect(adminEmailAllowlist()).toEqual(["corey@example.com", "second@example.com"]);
    expect(isAdminEmail("COREY@example.com")).toBe(true);
    expect(isAdminEmail("  corey@example.com ")).toBe(true);
    expect(isAdminEmail("second@example.com")).toBe(true);
  });

  it("refuses near-misses and empty input", () => {
    setEnv({ ADMIN_EMAIL_ALLOWLIST: "corey@example.com" });
    expect(isAdminEmail("corey@example.co")).toBe(false);
    expect(isAdminEmail("")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });

  it("fails closed on a malformed list rather than taking down sign-in", () => {
    // A typo here must not throw out of every OTP request on party night.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ADMIN_EMAIL_ALLOWLIST: "not-an-email" });
    expect(adminEmailAllowlist()).toEqual([]);
    expect(isAdminEmail("not-an-email")).toBe(false);
    expect(error.mock.calls.flat().join(" ")).toContain("ADMIN_EMAIL_ALLOWLIST");
  });
});

/* -------------------------------------------------------------------------- */
/* URLs                                                                        */
/* -------------------------------------------------------------------------- */

describe("URLs", () => {
  it("prefers BETTER_AUTH_URL and falls back to the Convex site URL", () => {
    setEnv({
      BETTER_AUTH_URL: "https://auth.partybooth.test",
      CONVEX_SITE_URL: "https://x.convex.site",
    });
    expect(authBaseUrl()).toBe("https://auth.partybooth.test");

    setEnv({ BETTER_AUTH_URL: undefined });
    expect(authBaseUrl()).toBe("https://x.convex.site");
  });

  it("names the missing variable when neither is set", () => {
    clearEnv();
    expect(() => authBaseUrl()).toThrow(/CONVEX_SITE_URL/);
  });

  it("names SITE_URL when it is missing", () => {
    clearEnv();
    expect(() => siteUrl()).toThrow(/SITE_URL/);
  });

  it("trusts the web origin, the auth origin and the app scheme", () => {
    setEnv({
      SITE_URL: "https://partybooth.test/",
      CONVEX_SITE_URL: "https://x.convex.site",
    });
    const origins = trustedOrigins();
    expect(origins).toContain("https://partybooth.test");
    expect(origins).toContain("https://x.convex.site");
    expect(origins).toContain("partybooth://");
    // The trailing slash is normalised away rather than producing a second entry.
    expect(origins).not.toContain("https://partybooth.test/");
  });

  it("still returns the app scheme with nothing else configured", () => {
    clearEnv();
    expect(trustedOrigins()).toEqual(["partybooth://"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Social providers                                                            */
/* -------------------------------------------------------------------------- */

describe("social providers", () => {
  it("offers nothing but email OTP with no credentials", () => {
    clearEnv();
    expect(socialProviderConfig()).toEqual({});
    expect(availableSignInMethods()).toEqual({ emailOtp: true, google: false, apple: false });
  });

  it("adds Google once both halves are present", () => {
    setEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" });
    expect(isGoogleConfigured()).toBe(true);
    expect(socialProviderConfig().google).toEqual({ clientId: "gid", clientSecret: "gsecret" });
  });

  it("does not add Google with only half the credentials", () => {
    setEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: undefined });
    expect(isGoogleConfigured()).toBe(false);
    expect(socialProviderConfig().google).toBeUndefined();
  });

  it("configures Apple for the native id-token flow, with no client secret", () => {
    setEnv({
      APPLE_CLIENT_ID: "com.partybooth.web",
      APPLE_APP_BUNDLE_IDENTIFIER: "com.partybooth.app",
    });
    expect(isAppleConfigured()).toBe(true);
    expect(socialProviderConfig().apple).toEqual({
      clientId: "com.partybooth.web",
      clientSecret: "",
      appBundleIdentifier: "com.partybooth.app",
      audience: ["com.partybooth.web", "com.partybooth.app"],
    });
  });

  it("does not demand the .p8 key material the launch flow never reads", () => {
    // PLAN.md: Sign in with Apple is app-only, so no web redirect flow, so no
    // client-secret JWT — APPLE_TEAM_ID / KEY_ID / PRIVATE_KEY stay unread.
    setEnv({
      APPLE_CLIENT_ID: "com.partybooth.web",
      APPLE_APP_BUNDLE_IDENTIFIER: "com.partybooth.app",
    });
    delete process.env["APPLE_TEAM_ID"];
    delete process.env["APPLE_KEY_ID"];
    delete process.env["APPLE_PRIVATE_KEY"];
    resetEnvCache(serverEnv);
    expect(isAppleConfigured()).toBe(true);
  });

  it("reports the bundle id the app must match", () => {
    setEnv({ APPLE_APP_BUNDLE_IDENTIFIER: "com.partybooth.app" });
    expect(appleBundleIdentifier()).toBe("com.partybooth.app");
    clearEnv();
    expect(appleBundleIdentifier()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* App Review demo account                                                     */
/* -------------------------------------------------------------------------- */

describe("demo login", () => {
  it("does not exist unless all three variables are set", () => {
    clearEnv();
    expect(demoLogin()).toBeUndefined();

    setEnv({ DEMO_LOGIN_EMAIL: "review@partybooth.test" });
    expect(demoLogin()).toBeUndefined();

    setEnv({ DEMO_LOGIN_OTP: "424242" });
    // Still off: the expiry is required, not optional. A bypass whose only
    // off-switch is somebody remembering to unset a variable is a published
    // password with a reminder attached.
    expect(demoLogin()).toBeUndefined();

    setEnv({ DEMO_LOGIN_EXPIRES_AT: "2099-01-01T00:00:00Z" });
    expect(demoLogin()).toEqual({ email: "review@partybooth.test", code: "424242" });
  });

  it("switches itself off once the expiry has passed", () => {
    setEnv({
      DEMO_LOGIN_EMAIL: "review@partybooth.test",
      DEMO_LOGIN_OTP: "424242",
      DEMO_LOGIN_EXPIRES_AT: "2020-01-01T00:00:00Z",
    });
    expect(demoLogin()).toBeUndefined();
    expect(isDemoLogin("review@partybooth.test", "424242")).toBe(false);
  });

  it("fails closed on an expiry it cannot parse", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({
      DEMO_LOGIN_EMAIL: "review@partybooth.test",
      DEMO_LOGIN_OTP: "424242",
      DEMO_LOGIN_EXPIRES_AT: "next tuesday",
    });
    expect(demoLogin()).toBeUndefined();
    expect(error.mock.calls.flat().join(" ")).toContain("DEMO_LOGIN_EXPIRES_AT");
  });

  it("matches the reviewer's fixed code, and nothing else", () => {
    setEnv({
      DEMO_LOGIN_EMAIL: "Review@PartyBooth.test",
      DEMO_LOGIN_OTP: "424242",
      DEMO_LOGIN_EXPIRES_AT: "2099-01-01T00:00:00Z",
    });
    expect(isDemoLogin("review@partybooth.test", "424242")).toBe(true);
    expect(isDemoLogin("REVIEW@partybooth.test", "424242")).toBe(true);
    expect(isDemoLogin("review@partybooth.test", "424243")).toBe(false);
    expect(isDemoLogin("someone@partybooth.test", "424242")).toBe(false);
  });

  it("is inert when the deployment has not opted in", () => {
    clearEnv();
    expect(isDemoLogin("review@partybooth.test", "424242")).toBe(false);
  });

  it("rejects a code that is not six digits, so a typo cannot become a bypass", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({
      DEMO_LOGIN_EMAIL: "review@partybooth.test",
      DEMO_LOGIN_OTP: "42",
      DEMO_LOGIN_EXPIRES_AT: "2099-01-01T00:00:00Z",
    });
    expect(demoLogin()).toBeUndefined();
    expect(error.mock.calls.flat().join(" ")).toContain("DEMO_LOGIN_OTP");
  });
});
