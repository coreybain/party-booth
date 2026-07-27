import { createEnv, envHas, type InferEnv, type RuntimeEnv } from "./create-env";
import { mobileVars, type MobileVars } from "./schema";

export type MobileEnv = InferEnv<MobileVars>;

/**
 * Build the Expo-facing environment from an explicit map of values.
 *
 * **`apps/mobile` should call this from its own source**, not import
 * {@link mobileEnv}. `babel-preset-expo` inlines `EXPO_PUBLIC_*` by literal text
 * substitution and deliberately skips files inside `node_modules` — and a
 * workspace package is inside `node_modules` as far as Metro is concerned. So:
 *
 * ```ts
 * // apps/mobile/src/env.ts
 * import { createMobileEnv } from "@partybooth/env/mobile";
 *
 * export const env = createMobileEnv({
 *   EXPO_PUBLIC_SITE_URL: process.env.EXPO_PUBLIC_SITE_URL,
 *   EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
 *   EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
 *   EXPO_PUBLIC_EAS_PROJECT_ID: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
 * });
 * ```
 */
export function createMobileEnv(runtimeEnv: RuntimeEnv<MobileVars>): MobileEnv {
  return createEnv({
    id: "mobile",
    vars: mobileVars,
    runtimeEnv,
    source: "apps/mobile/.env.local (Expo reads it at bundle time — restart the dev server)",
  });
}

/**
 * Convenience instance. Works when the reads below are inlined (Expo web, tests,
 * Node) but see {@link createMobileEnv} before relying on it inside the app.
 */
export const mobileEnv: MobileEnv = createMobileEnv({
  EXPO_PUBLIC_SITE_URL: process.env.EXPO_PUBLIC_SITE_URL,
  EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
  EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  EXPO_PUBLIC_EAS_PROJECT_ID: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
});

/** Optional providers in the app. Never throws. */
export function mobileFeatures(env: MobileEnv = mobileEnv) {
  return {
    sentry: envHas(env, "EXPO_PUBLIC_SENTRY_DSN"),
    push: envHas(env, "EXPO_PUBLIC_EAS_PROJECT_ID"),
  } as const;
}
