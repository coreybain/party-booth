import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  available: true,
  signInAsync: vi.fn(),
  social: vi.fn(),
  createAppleNonce: vi.fn(),
}));

vi.mock("@better-auth/expo/client", () => ({ expoClient: vi.fn(() => ({})) }));
vi.mock("@convex-dev/better-auth/client/plugins", () => ({ convexClient: vi.fn(() => ({})) }));
vi.mock("better-auth/client/plugins", () => ({ emailOTPClient: vi.fn(() => ({})) }));
vi.mock("better-auth/react", () => ({ createAuthClient: vi.fn(() => ({})) }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: vi.fn(async () => fake.available),
  signInAsync: (...args: unknown[]) => fake.signInAsync(...args),
}));
vi.mock("./apple-nonce", () => ({
  createAppleNonce: (...args: unknown[]) => fake.createAppleNonce(...args),
}));

import { authCookieHeaders, signInWithApple } from "./auth-client";

function client() {
  return { signIn: { social: fake.social } } as never;
}

beforeEach(() => {
  fake.available = true;
  fake.signInAsync.mockReset().mockResolvedValue({ identityToken: "apple-jwt" });
  fake.social.mockReset().mockResolvedValue({ error: null });
  fake.createAppleNonce.mockReset().mockResolvedValue({
    raw: "raw-random-nonce",
    sha256: "sha256-for-apple",
  });
});

describe("native Sign in with Apple", () => {
  it("sends the hash to Apple and the raw nonce to Better Auth", async () => {
    await expect(signInWithApple(client(), "/")).resolves.toEqual({ status: "signed-in" });

    expect(fake.signInAsync).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: "sha256-for-apple" }),
    );
    expect(fake.social).toHaveBeenCalledWith({
      provider: "apple",
      idToken: { token: "apple-jwt", nonce: "raw-random-nonce" },
    });
  });

  it("keeps a dismissed native sheet as a cancellation, not an error", async () => {
    fake.signInAsync.mockRejectedValue({ code: "ERR_REQUEST_CANCELED" });

    await expect(signInWithApple(client(), "/")).resolves.toEqual({ status: "cancelled" });
    expect(fake.social).not.toHaveBeenCalled();
  });

  it("uses browser Apple sign-in when the native API is unavailable", async () => {
    fake.available = false;

    await expect(signInWithApple(client(), "/return")).resolves.toEqual({
      status: "signed-in",
    });
    expect(fake.createAppleNonce).not.toHaveBeenCalled();
    expect(fake.social).toHaveBeenCalledWith({ provider: "apple", callbackURL: "/return" });
  });
});

describe("native request authentication", () => {
  it("forwards Better Auth's stored cookie without exposing storage details", () => {
    const authClient = {
      getCookie: () => "better-auth.session_token=private",
    } as never;

    expect(authCookieHeaders(authClient)).toEqual({
      cookie: "better-auth.session_token=private",
    });
  });

  it("does not send an empty Cookie header", () => {
    expect(authCookieHeaders({ getCookie: () => "" } as never)).toEqual({});
  });
});
