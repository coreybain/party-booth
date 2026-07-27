import { z } from "zod";

import { envVar } from "./create-env";

/* -------------------------------------------------------------------------- */
/* Reusable field types                                                        */
/* -------------------------------------------------------------------------- */

const nonEmpty = z.string().min(1, "must not be empty");
const httpUrl = z.url({ protocol: /^https?$/, error: "must be an absolute http(s) URL" });
const email = z.email();

/** Comma-separated list → trimmed, lower-cased, de-duplicated array. */
const emailList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.email()).min(1, "must contain at least one email address"));

/**
 * Storage regions PartyBooth can write to. Per PLAN.md the beta is a single
 * region; `events.storageRegion` carries it per event from day one.
 */
export const STORAGE_REGIONS = ["pdx1"] as const;
export type StorageRegion = (typeof STORAGE_REGIONS)[number];

/* -------------------------------------------------------------------------- */
/* Server variables (never shipped to a browser or app bundle)                 */
/* -------------------------------------------------------------------------- */

export const serverVars = {
  NODE_ENV: envVar(
    z.enum(["development", "test", "production"]).default("development"),
    "Set by the runtime; you never write this by hand.",
  ),

  /* --- Site ------------------------------------------------------------- */
  SITE_URL: envVar(
    httpUrl,
    "Canonical public origin used in emails, QR universal links and OAuth redirects — the domain from TODO.md. Same value as NEXT_PUBLIC_SITE_URL.",
  ),

  /* --- Convex ----------------------------------------------------------- */
  CONVEX_DEPLOYMENT: envVar(
    nonEmpty.optional(),
    "Written automatically by `npx convex dev`; identifies the active deployment. Leave unset in production.",
  ),
  CONVEX_URL: envVar(
    httpUrl,
    "Convex dashboard → Settings → Deployment URL (https://<name>.convex.cloud). Same value as NEXT_PUBLIC_CONVEX_URL.",
  ),
  CONVEX_SITE_URL: envVar(
    httpUrl,
    "Convex dashboard → Settings → HTTP Actions URL (https://<name>.convex.site). Better Auth mounts its handlers here.",
  ),
  CONVEX_DEPLOY_KEY: envVar(
    nonEmpty.optional(),
    "Convex dashboard → Settings → Deploy Keys. Only needed by CI / Vercel builds.",
    { secret: true },
  ),

  /* --- Better Auth ------------------------------------------------------ */
  BETTER_AUTH_SECRET: envVar(
    z.string().min(32, "must be at least 32 characters — generate with `openssl rand -base64 32`"),
    "Generate yourself: `openssl rand -base64 32`. Must be identical in Convex and Vercel.",
    { secret: true },
  ),
  BETTER_AUTH_URL: envVar(
    httpUrl,
    "Base URL Better Auth serves from — normally the same as CONVEX_SITE_URL.",
  ),

  /* --- Google OAuth ----------------------------------------------------- */
  GOOGLE_CLIENT_ID: envVar(
    nonEmpty,
    "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application).",
  ),
  GOOGLE_CLIENT_SECRET: envVar(
    nonEmpty,
    "Same Google Cloud Console OAuth client → Client secret.",
    { secret: true },
  ),

  /* --- Sign in with Apple ----------------------------------------------- */
  APPLE_CLIENT_ID: envVar(
    nonEmpty,
    "Apple Developer → Certificates, Identifiers & Profiles → Identifiers → Services ID (e.g. com.partybooth.web).",
  ),
  APPLE_APP_BUNDLE_IDENTIFIER: envVar(
    nonEmpty,
    "The iOS app's bundle id — com.partybooth.app (native Sign in with Apple returns this as the audience).",
  ),
  APPLE_TEAM_ID: envVar(
    nonEmpty,
    "Apple Developer → Membership details → Team ID (10 characters).",
  ),
  APPLE_KEY_ID: envVar(
    nonEmpty,
    "Apple Developer → Keys → the Sign in with Apple key you created → Key ID.",
  ),
  APPLE_PRIVATE_KEY: envVar(
    nonEmpty,
    "Contents of the AuthKey_<KEY_ID>.p8 file downloaded from Apple, newlines escaped as \\n. Downloadable once only.",
    { secret: true },
  ),

  /* --- Resend (OTP + invite email) -------------------------------------- */
  RESEND_API_KEY: envVar(
    z.string().startsWith("re_", "Resend keys start with `re_`"),
    "Resend dashboard → API Keys → Create API Key (sending permission).",
    { secret: true },
  ),
  RESEND_FROM_EMAIL: envVar(
    email,
    "An address on the Resend-verified domain, e.g. hello@partybooth.example — DNS must be verified first.",
  ),
  RESEND_FROM_NAME: envVar(
    nonEmpty.default("PartyBooth"),
    "Display name on outgoing email. Defaults to PartyBooth.",
  ),

  /* --- UploadThing (private media storage) ------------------------------ */
  UPLOADTHING_TOKEN: envVar(
    nonEmpty,
    "UploadThing dashboard → your app → API Keys → V7 token. App must be on a paid plan, region pdx1, default ACL Private.",
    { secret: true },
  ),
  UPLOADTHING_APP_ID: envVar(
    nonEmpty.optional(),
    "UploadThing dashboard → app id. Encoded inside the token; only set it if a tool asks for it separately.",
  ),
  STORAGE_DEFAULT_REGION: envVar(
    z.enum(STORAGE_REGIONS).default("pdx1"),
    "UploadThing region new events are created in. Beta is pdx1 (Portland) only.",
  ),

  /* --- Sentry ----------------------------------------------------------- */
  SENTRY_DSN: envVar(
    httpUrl.optional(),
    "Sentry → Projects → partybooth-server → Client Keys (DSN). Used by Convex + Next.js server. Unset = error reporting disabled.",
  ),
  SENTRY_ENVIRONMENT: envVar(
    nonEmpty.optional(),
    "Free-form environment tag (development / preview / production). Defaults to NODE_ENV.",
  ),
  SENTRY_ORG: envVar(
    nonEmpty.optional(),
    "Sentry organisation slug. Only needed to upload source maps at build time.",
  ),
  SENTRY_PROJECT: envVar(
    nonEmpty.optional(),
    "Sentry project slug. Only needed to upload source maps at build time.",
  ),
  SENTRY_AUTH_TOKEN: envVar(
    nonEmpty.optional(),
    "Sentry → Settings → Auth Tokens (project:releases). Build-time only; never set it in the browser.",
    { secret: true },
  ),

  /* --- Admin console + App Review demo account -------------------------- */
  ADMIN_EMAIL_ALLOWLIST: envVar(
    emailList,
    "Comma-separated emails allowed to sign in at /admin. Start with your own address.",
  ),
  DEMO_LOGIN_EMAIL: envVar(
    email.optional(),
    "Fixed reviewer account for App Review (e.g. review@partybooth.example). Unset outside submission builds.",
  ),
  DEMO_LOGIN_OTP: envVar(
    z
      .string()
      .regex(/^\d{6}$/, "must be exactly six digits")
      .optional(),
    "Fixed six-digit code the reviewer demo account accepts instead of a real emailed OTP.",
    { secret: true },
  ),

  /* --- Expo push (server side) ------------------------------------------ */
  EXPO_ACCESS_TOKEN: envVar(
    nonEmpty.optional(),
    "expo.dev → Account settings → Access tokens. Optional; enables enhanced push security.",
    { secret: true },
  ),
  EAS_PROJECT_ID: envVar(
    z.uuid().optional(),
    "expo.dev → your project → Project ID (UUID). Required to send Expo push notifications.",
  ),
} as const;

/* -------------------------------------------------------------------------- */
/* Web client variables (inlined into the browser bundle — public by design)   */
/* -------------------------------------------------------------------------- */

export const clientVars = {
  NEXT_PUBLIC_SITE_URL: envVar(
    httpUrl,
    "Same value as SITE_URL. On Vercel, use the production domain, not the preview URL.",
  ),
  NEXT_PUBLIC_CONVEX_URL: envVar(
    httpUrl,
    "Same value as CONVEX_URL (https://<name>.convex.cloud).",
  ),
  NEXT_PUBLIC_SENTRY_DSN: envVar(
    httpUrl.optional(),
    "Sentry → partybooth-web → Client Keys (DSN). Unset = browser error reporting disabled.",
  ),
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: envVar(
    nonEmpty.optional(),
    "Environment tag for browser events. Defaults to the Vercel environment.",
  ),
} as const;

/* -------------------------------------------------------------------------- */
/* Mobile variables (inlined into the Expo bundle — public by design)          */
/* -------------------------------------------------------------------------- */

export const mobileVars = {
  EXPO_PUBLIC_SITE_URL: envVar(httpUrl, "Same value as SITE_URL — used for universal links."),
  EXPO_PUBLIC_CONVEX_URL: envVar(httpUrl, "Same value as CONVEX_URL."),
  EXPO_PUBLIC_CONVEX_SITE_URL: envVar(
    httpUrl.optional(),
    "Same value as CONVEX_SITE_URL (https://<name>.convex.site) — Better Auth is mounted there. Optional: the app derives it from EXPO_PUBLIC_CONVEX_URL when unset. Set it explicitly for self-hosted or proxied Convex deployments.",
  ),
  EXPO_PUBLIC_SENTRY_DSN: envVar(
    httpUrl.optional(),
    "Sentry → partybooth-mobile → Client Keys (DSN). Unset = mobile error reporting disabled.",
  ),
  EXPO_PUBLIC_EAS_PROJECT_ID: envVar(
    z.uuid().optional(),
    "Same value as EAS_PROJECT_ID; the app needs it to register for push tokens.",
  ),
} as const;

export type ServerVars = typeof serverVars;
export type ClientVars = typeof clientVars;
export type MobileVars = typeof mobileVars;
