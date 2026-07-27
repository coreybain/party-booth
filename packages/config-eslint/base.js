import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Build output and generated code that no config should ever lint. */
export const ignores = globalIgnores([
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.expo/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/*.tsbuildinfo",
  "**/convex/_generated/**",
  "**/next-env.d.ts",
  "**/expo-env.d.ts",
]);

/**
 * Files allowed to read `process.env` directly. Everything else must import
 * from `@partybooth/env`. (`packages/env` switches the rule off in its own
 * config — flat-config globs are relative to the package being linted, so a
 * repo-absolute path would not match.)
 */
const ENV_ESCAPE_HATCH = [
  "**/*.config.{js,mjs,cjs,ts,mts,cts}",
  "**/app.config.{js,ts}",
  "**/scripts/**",
];

const PROCESS_ENV_MESSAGE =
  "Read configuration through @partybooth/env (serverEnv / clientEnv / mobileEnv) instead of process.env, so missing variables fail with a clear message.";

/**
 * Shared, non-type-checked TypeScript rules. Type-aware linting is intentionally
 * off: it is slow and needs per-package project wiring we do not need before launch.
 */
export const baseConfig = defineConfig([
  ignores,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.es2021 },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-implicit-coercion": "warn",
      "object-shorthand": ["warn", "properties"],
      "prefer-const": ["error", { destructuring: "all" }],
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']",
          message: PROCESS_ENV_MESSAGE,
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    files: ENV_ESCAPE_HATCH,
    rules: { "no-restricted-syntax": "off", "no-console": "off" },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/tests/**", "**/__tests__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Must stay last: turns off every rule Prettier owns.
  eslintConfigPrettier,
]);

export default baseConfig;
