import config from "@partybooth/config-eslint/expo";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([".expo/**", "dist/**", "ios/**", "android/**", "expo-env.d.ts"]),
  ...config,
  {
    /**
     * `src/env.ts` is the one module allowed to touch `process.env`, and it must do so
     * with literal `process.env.EXPO_PUBLIC_*` member expressions: `babel-preset-expo`
     * inlines those by text substitution at bundle time. Every other module reads the
     * validated `appConfig` / `mobileEnv` exported from there.
     */
    files: ["src/env.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
