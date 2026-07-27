import { defineConfig } from "eslint/config";
import globals from "globals";

import { baseConfig } from "./base.js";

/** For Node scripts, Convex functions and server-only packages. */
export const nodeConfig = defineConfig([
  ...baseConfig,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]);

export default nodeConfig;
