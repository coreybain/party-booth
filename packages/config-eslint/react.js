import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

import { baseConfig } from "./base.js";

const HARD_ERRORS = new Set(["react-hooks/rules-of-hooks"]);

/**
 * eslint-plugin-react-hooks v7 ships the React Compiler diagnostics as errors
 * (purity, immutability, set-state-in-effect, …). They are worth seeing, but a
 * failing lint on a style diagnostic should not block a sprint, so everything
 * except the Rules of Hooks itself is downgraded to a warning.
 */
const softenedRules = Object.fromEntries(
  Object.keys(reactHooks.configs.flat.recommended.rules ?? {})
    .filter((rule) => !HARD_ERRORS.has(rule))
    .map((rule) => [rule, "warn"]),
);

/** Shared React rules (used by both the Next.js and Expo presets). */
export const reactConfig = defineConfig([
  ...baseConfig,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...softenedRules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
]);

export default reactConfig;
