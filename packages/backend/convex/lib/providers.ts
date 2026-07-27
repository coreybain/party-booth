import { envHasAll, envOptional } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import type { BetterAuthOptions } from "better-auth/minimal";

/**
 * Social sign-in providers, each included only when its configuration exists.
 *
 * A deployment with no Google client still boots and still serves email OTP;
 * the Google button simply is not offered. That matters because none of these
 * credentials exist until Corey finishes the provider setup, and a backend that
 * refuses to start without them would block every other sprint.
 */
export function socialProviderConfig(): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (isGoogleConfigured()) {
    providers.google = {
      clientId: serverEnv.GOOGLE_CLIENT_ID,
      clientSecret: serverEnv.GOOGLE_CLIENT_SECRET,
    };
  }

  if (isAppleConfigured()) {
    const servicesId = serverEnv.APPLE_CLIENT_ID;
    const bundleId = serverEnv.APPLE_APP_BUNDLE_IDENTIFIER;
    providers.apple = {
      clientId: servicesId,
      // Empty on purpose — see `isAppleConfigured`.
      clientSecret: "",
      appBundleIdentifier: bundleId,
      // Native tokens carry the bundle id as their audience; a web Services ID
      // token would carry the Services ID. Accept either.
      audience: [servicesId, bundleId],
    };
  }

  return providers;
}

/** Google is used on both the web (redirect flow) and in the app (id token). */
export function isGoogleConfigured(): boolean {
  return envHasAll(serverEnv, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
}

/**
 * Apple needs **only** the Services ID and the bundle id.
 *
 * PLAN.md makes Sign in with Apple app-only ("no Apple web OAuth"). The native
 * flow posts an identity token which Better Auth verifies against Apple's
 * published public keys, checking the audience — no client secret involved. The
 * client secret is a JWT signed with the `.p8` key, and it is only needed for
 * the *web* redirect flow.
 *
 * This is deliberately a narrower check than `serverFeatures.appleOAuth` in
 * `@partybooth/env`, which also demands `APPLE_TEAM_ID`, `APPLE_KEY_ID` and
 * `APPLE_PRIVATE_KEY`. Gating on variables the launch flow never reads would
 * mean Apple sign-in silently missing from a correctly configured app build.
 * Those three stay in `.env.example` for the day web Apple sign-in is added.
 */
export function isAppleConfigured(): boolean {
  return envHasAll(serverEnv, ["APPLE_CLIENT_ID", "APPLE_APP_BUNDLE_IDENTIFIER"]);
}

/** Which sign-in methods a client should offer. Safe to read with no config. */
export function availableSignInMethods(): {
  emailOtp: boolean;
  google: boolean;
  apple: boolean;
} {
  return {
    // Email OTP always works: with no Resend key the code goes to the logs.
    emailOtp: true,
    google: isGoogleConfigured(),
    apple: isAppleConfigured(),
  };
}

/** The bundle id the app must ship with, when configured. */
export function appleBundleIdentifier(): string | undefined {
  return envOptional(serverEnv, "APPLE_APP_BUNDLE_IDENTIFIER");
}
