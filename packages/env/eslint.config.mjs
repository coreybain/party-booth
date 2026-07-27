import config from "@partybooth/config-eslint/node";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...config,
  {
    // This package is the one place that is *supposed* to read process.env.
    files: ["src/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
