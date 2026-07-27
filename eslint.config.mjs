import config from "@partybooth/config-eslint/node";
import { defineConfig, globalIgnores } from "eslint/config";

/**
 * Root config — lints repo-level scripts and config files only.
 * Every workspace package has its own `eslint.config.mjs`; Turborepo runs them.
 */
export default defineConfig([globalIgnores(["apps/**", "packages/**"]), ...config]);
