import { createEnv, envHas, envOptional, type InferEnv, type RuntimeEnv } from "./create-env";
import { clientVars, type ClientVars } from "./schema";

export type ClientEnv = InferEnv<ClientVars>;

/**
 * Build the browser-facing environment from an explicit map of values.
 *
 * Prefer the exported {@link clientEnv} — this factory exists for tests and for
 * the rare case where values arrive from somewhere other than `process.env`.
 */
export function createClientEnv(runtimeEnv: RuntimeEnv<ClientVars>): ClientEnv {
  return createEnv({
    id: "web client",
    vars: clientVars,
    runtimeEnv,
    source: ".env.local locally, Vercel Project Settings → Environment Variables in deployments",
  });
}

/**
 * Browser-facing configuration for `apps/web`.
 *
 * The reads below are written out one by one on purpose: Next.js inlines
 * `process.env.NEXT_PUBLIC_*` by literal text substitution, so a dynamic lookup
 * would compile to `undefined` in the client bundle.
 *
 * `apps/web/next.config.ts` must list this package in `transpilePackages` for
 * the substitution to reach it:
 * `transpilePackages: ["@partybooth/env", "@partybooth/contracts"]`.
 */
export const clientEnv: ClientEnv = createClientEnv({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
});

/** Optional providers on the browser side. Never throws. */
export const clientFeatures = {
  get sentry(): boolean {
    return envHas(clientEnv, "NEXT_PUBLIC_SENTRY_DSN");
  },
} as const;

/** Browser Sentry environment tag. Never throws. */
export function clientSentryEnvironment(): string {
  return envOptional(clientEnv, "NEXT_PUBLIC_SENTRY_ENVIRONMENT") ?? "development";
}
