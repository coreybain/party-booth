import config from "@partybooth/config-eslint/next";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...config,
  {
    // Sentry's instrumentation entry points are loaded by Next.js before any
    // application module, so they cannot import @partybooth/env (its Proxy
    // would be evaluated outside the runtime Next.js sets up). They read the
    // handful of variables they need from process.env directly, on purpose.
    files: ["instrumentation-client.ts", "instrumentation.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
