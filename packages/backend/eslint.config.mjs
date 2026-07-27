import config from "@partybooth/config-eslint/node";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["convex/_generated/**"]),
  ...config,
  {
    // Product code reads configuration through `@partybooth/env`. Tests are the
    // one place that has to write it, so they can set process.env directly.
    files: ["**/*.{test,spec}.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
