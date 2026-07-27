/**
 * Better Auth client for apps/mobile.
 *
 * Composition (per the Convex + Better Auth Expo guide):
 *   - `expoClient`  — stores the session cookie in the iOS keychain / Android keystore
 *                     via expo-secure-store, and rewrites `callbackURL` into a
 *                     `partybooth://` deep link so OAuth returns to the app.
 *   - `convexClient` — hands the session token to Convex so `ctx.auth` resolves.
 *
 * `baseURL` is the **Convex site URL** (`*.convex.site`), because Better Auth is mounted
 * on Convex HTTP actions — not the Convex API URL and not the website.
 *
 * The client is created lazily so an unconfigured checkout never constructs one.
 */

import { expoClient } from "@better-auth/expo/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

import type { BetterAuthClientPlugin } from "better-auth/client";

/**
 * Upstream type-variance workaround — remove when Better Auth fixes it.
 *
 * `BetterAuthClientPlugin` declares `getActions` as a *property* holding a function, so
 * TypeScript checks its parameters contravariantly under `strictFunctionTypes`.
 * `@better-auth/expo`'s `expoClient` declares `getActions` as a *method*, and the deep
 * conditional generics inside `@better-fetch`'s option inference then fail to prove the
 * two `BetterFetch` parameter types are the same — even though they resolve to identical
 * defaults. Verified with better-auth, @better-auth/expo and @better-fetch/fetch all
 * resolving to a single copy (1.6.25 / 1.6.25 / 1.3.1), so this is not version skew.
 *
 * Only the offending `getActions` member is retyped — casting the whole plugin to the
 * bare `BetterAuthClientPlugin` interface would widen its `$InferServerPlugin` to
 * `Record<string, any>`, and the intersection Better Auth builds across plugins then
 * collapses `useSession().data` to `never`. Narrowing the cast to one member keeps
 * session types, social sign-in options and the Convex plugin fully inferred; the only
 * thing lost is the plugin's `getCookie` action, which PartyBooth does not use.
 *
 * Retry removing this on the next better-auth upgrade.
 */
type ExpoAuthPlugin = Omit<ReturnType<typeof expoClient>, "getActions"> & {
  getActions: NonNullable<BetterAuthClientPlugin["getActions"]>;
};

const expoAuthPlugin = (opts: Parameters<typeof expoClient>[0]): ExpoAuthPlugin =>
  expoClient(opts) as unknown as ExpoAuthPlugin;

function createPartyBoothAuthClient(baseURL: string, scheme: string) {
  return createAuthClient({
    baseURL,
    plugins: [
      expoAuthPlugin({
        scheme,
        storagePrefix: scheme,
        storage: SecureStore,
      }),
      convexClient(),
    ],
  });
}

export type AuthClient = ReturnType<typeof createPartyBoothAuthClient>;

let cached: { readonly key: string; readonly client: AuthClient } | undefined;

/** Get (or create) the singleton auth client for the given deployment. */
export function getAuthClient(baseURL: string, scheme: string): AuthClient {
  const key = `${baseURL}|${scheme}`;
  if (cached?.key !== key) {
    cached = { key, client: createPartyBoothAuthClient(baseURL, scheme) };
  }
  return cached.client;
}

/** Test/reset seam. */
export function resetAuthClient(): void {
  cached = undefined;
}

/** Providers offered in the app. Web guests get Google + OTP instead (PLAN.md). */
export const SOCIAL_PROVIDERS = ["apple", "google"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export type SignInOutcome =
  | { readonly status: "signed-in" }
  /** User dismissed the sheet — not an error, must not show a red toast. */
  | { readonly status: "cancelled" }
  | { readonly status: "error"; readonly message: string };

/** Recognise the several ways "the user backed out" surfaces across providers. */
function isCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_REQUEST_CANCELED" || code === "ERR_CANCELED") return true;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("cancel") || message.includes("dismiss") || message.includes("user closed")
  );
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "Sign-in failed. Check your connection and try again.";
}

/**
 * Browser-based OAuth. `callbackURL` is a path, not a URL — `expoClient` turns it into
 * `partybooth://<path>` and opens the system browser, which is what both Google and
 * Apple require (an embedded WebView is rejected by Google and by App Review).
 */
async function signInWithBrowser(
  client: AuthClient,
  provider: SocialProvider,
  callbackPath: string,
): Promise<SignInOutcome> {
  try {
    const { error } = await client.signIn.social({ provider, callbackURL: callbackPath });
    if (error) return { status: "error", message: error.message ?? toMessage(error) };
    return { status: "signed-in" };
  } catch (error) {
    if (isCancellation(error)) return { status: "cancelled" };
    return { status: "error", message: toMessage(error) };
  }
}

export function signInWithGoogle(client: AuthClient, callbackPath: string): Promise<SignInOutcome> {
  return signInWithBrowser(client, "google", callbackPath);
}

/**
 * Sign in with Apple.
 *
 * On iOS this uses the **native** sheet and exchanges the resulting identity token
 * directly — App Review expects the system UI, and it is the only path that works when
 * the user hides their email behind a private relay. Everywhere else it falls back to
 * the browser flow.
 *
 * The server must set `appBundleIdentifier` on the Apple provider (see
 * `APPLE_APP_BUNDLE_IDENTIFIER` in .env.example) or the identity token fails JWT
 * validation — native sign-in is audienced to the bundle id, not the Services ID.
 *
 * TODO(Sprint 2): pass a `nonce`. It is optional here on purpose — Apple compares the
 * SHA-256 of the value it was given, and getting the "who hashes it" contract wrong
 * between expo-apple-authentication and Better Auth silently breaks sign-in. Wire it
 * deliberately, with a device test, rather than guessing in a scaffold.
 */
export async function signInWithApple(
  client: AuthClient,
  callbackPath: string,
): Promise<SignInOutcome> {
  const AppleAuthentication = await import("expo-apple-authentication");

  // Throws on platforms without the native module; treat that as "not available".
  const available = await AppleAuthentication.isAvailableAsync().catch(() => false);
  if (!available) return signInWithBrowser(client, "apple", callbackPath);

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      return { status: "error", message: "Apple did not return an identity token." };
    }

    const { error } = await client.signIn.social({
      provider: "apple",
      idToken: { token: credential.identityToken },
    });
    if (error) return { status: "error", message: error.message ?? toMessage(error) };
    return { status: "signed-in" };
  } catch (error) {
    if (isCancellation(error)) return { status: "cancelled" };
    return { status: "error", message: toMessage(error) };
  }
}

export type ActionOutcome =
  { readonly status: "ok" } | { readonly status: "error"; readonly message: string };

/** Sign out, clearing the secure-store session. Never throws. */
export async function signOut(client: AuthClient): Promise<ActionOutcome> {
  try {
    await client.signOut();
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: toMessage(error) };
  }
}
