import config from "@partybooth/config-eslint/node";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["convex/_generated/**"]),
  ...config,
  {
    // Product code reads configuration through `@partybooth/env`. Tests are the
    // one place that has to write it, so they can set process.env directly —
    // including the fixtures module the suites share, which is named with two
    // dots so the Convex bundler skips it.
    files: ["**/*.{test,spec}.ts", "**/testing.helpers.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
