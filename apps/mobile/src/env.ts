/**
 * The single place `apps/mobile` reads its environment.
 *
 * `babel-preset-expo` inlines `EXPO_PUBLIC_*` by *literal text substitution* and skips
 * files inside `node_modules`. Metro treats a workspace package as being inside
 * `node_modules`, so `@partybooth/env`'s own `mobileEnv` export would receive
 * `undefined` for everything in a real bundle. Hence the reads below live here, in app
 * source, exactly as `createMobileEnv`'s doc comment prescribes.
 *
 * Nothing else in the app should touch `process.env`.
 */

import { describeEnv, envOptional, type EnvVarReport } from "@partybooth/env";
import { createMobileEnv } from "@partybooth/env/mobile";

import { resolveAppConfig, type AppConfig, type RawMobileEnv } from "./lib/config";

export const mobileEnv = createMobileEnv({
  EXPO_PUBLIC_SITE_URL: process.env.EXPO_PUBLIC_SITE_URL,
  EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
  EXPO_PUBLIC_CONVEX_SITE_URL: process.env.EXPO_PUBLIC_CONVEX_SITE_URL,
  EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  EXPO_PUBLIC_EAS_PROJECT_ID: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
});

/**
 * Read one variable without throwing.
 *
 * `envOptional` swallows a *missing* variable but rethrows an *invalid* one. On a phone
 * there is nobody to read a red screen, so a malformed value is treated the same as an
 * absent one and surfaced through the "not configured" screen instead.
 */
function read(key: keyof RawMobileEnv): string | undefined {
  try {
    return envOptional(mobileEnv, key);
  } catch {
    return undefined;
  }
}

/** Per-variable presence/validity plus the "where do I get this" hint, for diagnostics. */
export const envReports: readonly EnvVarReport[] = describeEnv(mobileEnv);

/** Resolved once at module load — `EXPO_PUBLIC_*` values are fixed at bundle time. */
export const appConfig: AppConfig = resolveAppConfig({
  EXPO_PUBLIC_SITE_URL: read("EXPO_PUBLIC_SITE_URL"),
  EXPO_PUBLIC_CONVEX_URL: read("EXPO_PUBLIC_CONVEX_URL"),
  EXPO_PUBLIC_CONVEX_SITE_URL: read("EXPO_PUBLIC_CONVEX_SITE_URL"),
  EXPO_PUBLIC_SENTRY_DSN: read("EXPO_PUBLIC_SENTRY_DSN"),
  EXPO_PUBLIC_EAS_PROJECT_ID: read("EXPO_PUBLIC_EAS_PROJECT_ID"),
});

/** Look up the provenance hint for a variable, for the "not configured" screen. */
export function envHintFor(key: string): string | undefined {
  return envReports.find((report) => report.key === key)?.hint;
}
