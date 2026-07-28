import { createEnv, envHas, envHasAll, envOptional, type InferEnv } from "./create-env";
import { serverVars, type ServerVars } from "./schema";

export type ServerEnv = InferEnv<ServerVars>;

/**
 * Server-side configuration. Nothing is validated until a property is read, so
 * importing this module can never break a build.
 *
 * ```ts
 * import { serverEnv } from "@partybooth/env/server";
 * const key = serverEnv.RESEND_API_KEY; // throws a clear error only if unset
 * ```
 *
 * `process.env` is passed directly (not a snapshot) so Convex, Next.js and Node
 * all see values injected after module evaluation.
 */
export const serverEnv: ServerEnv = createEnv({
  id: "server",
  vars: serverVars,
  runtimeEnv: process.env as Record<string, string | undefined>,
  serverOnly: true,
  source:
    ".env.local for local dev, the Convex dashboard for Convex, and Vercel Project Settings → Environment Variables for the web app",
});

/**
 * Which optional providers are configured. These never throw, so call sites can
 * degrade to a no-op instead of crashing when a provider is not wired up yet.
 */
export const serverFeatures = {
  /** Sentry error reporting on the server / in Convex. */
  get sentry(): boolean {
    return envHas(serverEnv, "SENTRY_DSN");
  },
  /** Source-map upload during builds. */
  get sentrySourceMaps(): boolean {
    return envHasAll(serverEnv, ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]);
  },
  /** Transactional email (OTP codes, co-host invites). */
  get resend(): boolean {
    return envHasAll(serverEnv, ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]);
  },
  /** Google sign-in (web + app). */
  get googleOAuth(): boolean {
    return envHasAll(serverEnv, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  },
  /** Sign in with Apple (app only — see PLAN.md). */
  get appleOAuth(): boolean {
    return envHasAll(serverEnv, [
      "APPLE_CLIENT_ID",
      "APPLE_TEAM_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
    ]);
  },
  /** Private media storage. */
  get uploadthing(): boolean {
    return envHas(serverEnv, "UPLOADTHING_TOKEN");
  },
  /**
   * Whether the upload-completion callback can be authenticated at all.
   *
   * Separate from {@link uploadthing} because the two are set in different
   * dashboards and a deployment can plausibly have one without the other. With
   * this unset, `media.completeUpload` refuses every call — so uploads reach
   * storage and never leave `processing`, which is a visible, diagnosable
   * failure rather than an open door.
   */
  get uploadCallback(): boolean {
    return envHas(serverEnv, "UPLOAD_CALLBACK_SECRET");
  },
  /** Expo push notifications. */
  get expoPush(): boolean {
    return envHas(serverEnv, "EAS_PROJECT_ID");
  },
  /** Fixed-code reviewer login for App Review. */
  get demoLogin(): boolean {
    return envHasAll(serverEnv, ["DEMO_LOGIN_EMAIL", "DEMO_LOGIN_OTP", "DEMO_LOGIN_EXPIRES_AT"]);
  },
} as const;

/** Sentry environment tag, falling back to NODE_ENV. Never throws. */
export function sentryEnvironment(): string {
  return (
    envOptional(serverEnv, "SENTRY_ENVIRONMENT") ??
    envOptional(serverEnv, "NODE_ENV") ??
    "development"
  );
}

export {
  describeEnv,
  envAssert,
  envHas,
  envHasAll,
  envKeys,
  envOptional,
  EnvError,
  InvalidEnvError,
  MissingEnvError,
  ServerEnvAccessError,
} from "./create-env";
