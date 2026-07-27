import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig } from "eslint/config";
import globals from "globals";

import { reactConfig } from "./react.js";

/** For apps/web (Next.js App Router). */
export const nextConfig = defineConfig([
  ...reactConfig,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"]],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // App Router only — this rule scans for a pages/ directory that we do not have.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
]);

export default nextConfig;
