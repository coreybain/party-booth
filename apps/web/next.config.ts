import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * `Permissions-Policy` grants camera + microphone to same-origin pages now
 * because this app hosts guest mobile-web capture from Sprint 3 (PLAN.md →
 * "Guest mobile web"); without it `getUserMedia` is blocked in Chrome. Nothing
 * on the organiser side uses either capability yet.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Workspace packages are consumed as TypeScript source (no build step), so
   * Next.js has to compile them. `@partybooth/env` additionally *needs* this:
   * `NEXT_PUBLIC_*` inlining is literal text substitution and does not reach
   * `node_modules` otherwise.
   */
  transpilePackages: ["@partybooth/env", "@partybooth/contracts"],

  /**
   * Type errors fail the build. (Next.js 16 no longer runs ESLint during
   * `next build` at all — `pnpm lint` is the Turborepo task that does.)
   */
  typescript: { ignoreBuildErrors: false },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

/**
 * Source maps are only uploaded when all three Sentry build variables exist.
 * Without them the plugin still wires up server/client instrumentation, it just
 * skips the upload — so a developer with no Sentry account can build normally.
 *
 * `process.env` is read directly here because `next.config.ts` runs outside the
 * app's module graph, and it matches the repo's ESLint escape hatch for
 * `*.config.*` files.
 */
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;
const canUploadSourceMaps = Boolean(sentryOrg && sentryProject && process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: sentryOrg,
  project: sentryProject,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !canUploadSourceMaps },
  // `disableLogger` and `automaticVercelMonitors` are deliberately not set:
  // both are deprecated in @sentry/nextjs 10 in favour of `webpack.*` options,
  // and Next.js 16 builds with Turbopack, where neither is supported.
});
