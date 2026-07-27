/**
 * Turns raw `EXPO_PUBLIC_*` values into either a fully-wired runtime configuration or an
 * explicit "not configured" state.
 *
 * The app must build, boot, and render on a machine with no credentials at all (see the
 * repo-level constraint: everything typechecks and tests offline). Rather than letting
 * `new ConvexReactClient(undefined)` throw somewhere inside a provider, the whole
 * provider tree branches on the result of {@link resolveAppConfig} and shows a screen
 * naming the variables that are missing.
 *
 * No React Native imports here — this is unit-tested in plain Node.
 */

import { APP_SCHEME } from "./deep-links";

/** Variables the app genuinely cannot start without. */
export const REQUIRED_MOBILE_VARS = ["EXPO_PUBLIC_CONVEX_URL", "EXPO_PUBLIC_SITE_URL"] as const;
export type RequiredMobileVar = (typeof REQUIRED_MOBILE_VARS)[number];

/** Raw values, exactly as read from the bundle. `undefined` = unset or invalid. */
export interface RawMobileEnv {
  readonly EXPO_PUBLIC_SITE_URL: string | undefined;
  readonly EXPO_PUBLIC_CONVEX_URL: string | undefined;
  /** Optional explicit override; derived from `EXPO_PUBLIC_CONVEX_URL` when unset. */
  readonly EXPO_PUBLIC_CONVEX_SITE_URL?: string | undefined;
  readonly EXPO_PUBLIC_SENTRY_DSN: string | undefined;
  readonly EXPO_PUBLIC_EAS_PROJECT_ID: string | undefined;
}

/** Optional providers, each independently switchable by presence of its variable. */
export interface MobileFeatures {
  /** Crash/error reporting. Off unless `EXPO_PUBLIC_SENTRY_DSN` is set. */
  readonly sentry: boolean;
  /** Expo push registration. Needs the EAS project id to mint a token. */
  readonly push: boolean;
}

export interface ReadyAppConfig {
  readonly status: "ready";
  /** Convex WebSocket/API origin, e.g. `https://acute-lynx-123.convex.cloud`. */
  readonly convexUrl: string;
  /** Convex HTTP-actions origin — where Better Auth is mounted. */
  readonly convexSiteUrl: string;
  /** Public website origin; also the universal-link host. */
  readonly siteUrl: string;
  /** Custom URL scheme, used as the OAuth callback target. */
  readonly scheme: string;
  readonly sentryDsn: string | undefined;
  readonly easProjectId: string | undefined;
  readonly features: MobileFeatures;
}

export interface UnconfiguredAppConfig {
  readonly status: "unconfigured";
  readonly missing: readonly RequiredMobileVar[];
}

export type AppConfig = ReadyAppConfig | UnconfiguredAppConfig;

/**
 * Derive the Convex HTTP-actions origin from the Convex API origin.
 *
 * Convex serves HTTP actions (and therefore the Better Auth handler) from the same
 * deployment on the `.convex.site` domain rather than `.convex.cloud`. Deriving it means
 * one fewer variable to set and keep in sync.
 *
 * This is the **fallback**. `EXPO_PUBLIC_CONVEX_SITE_URL` wins whenever it is set, which
 * is the same explicit-variable convention `apps/web` uses with `CONVEX_SITE_URL`.
 * Self-hosted / proxied deployments do not follow the naming convention, so anything
 * that is not a `.convex.cloud` host is returned unchanged and should be set explicitly.
 */
export function convexSiteUrlFrom(convexUrl: string): string {
  try {
    const url = new URL(convexUrl);
    if (url.hostname.endsWith(".convex.cloud")) {
      url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
    }
    // `.origin` drops any stray path/query and normalises the trailing slash away.
    return url.origin;
  } catch {
    return convexUrl;
  }
}

/** Trim a trailing slash so joined paths never double up. */
function normaliseOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the app configuration. Never throws: a missing variable produces an
 * `"unconfigured"` result that the UI renders as an actionable checklist.
 */
export function resolveAppConfig(raw: RawMobileEnv, scheme: string = APP_SCHEME): AppConfig {
  const missing = REQUIRED_MOBILE_VARS.filter((name) => !isPresent(raw[name]));
  if (missing.length > 0) {
    return { status: "unconfigured", missing };
  }

  // Safe: `missing` is empty, so both required values passed `isPresent`.
  const convexUrl = normaliseOrigin(raw.EXPO_PUBLIC_CONVEX_URL as string);
  const siteUrl = normaliseOrigin(raw.EXPO_PUBLIC_SITE_URL as string);

  const sentryDsn = isPresent(raw.EXPO_PUBLIC_SENTRY_DSN) ? raw.EXPO_PUBLIC_SENTRY_DSN : undefined;
  const easProjectId = isPresent(raw.EXPO_PUBLIC_EAS_PROJECT_ID)
    ? raw.EXPO_PUBLIC_EAS_PROJECT_ID
    : undefined;

  // Explicit variable wins; the `.convex.cloud` → `.convex.site` derivation is the
  // fallback so a standard Convex deployment needs one fewer variable set.
  const convexSiteUrl = isPresent(raw.EXPO_PUBLIC_CONVEX_SITE_URL)
    ? normaliseOrigin(raw.EXPO_PUBLIC_CONVEX_SITE_URL)
    : convexSiteUrlFrom(convexUrl);

  return {
    status: "ready",
    convexUrl,
    convexSiteUrl,
    siteUrl,
    scheme,
    sentryDsn,
    easProjectId,
    features: {
      sentry: sentryDsn !== undefined,
      push: easProjectId !== undefined,
    },
  };
}
