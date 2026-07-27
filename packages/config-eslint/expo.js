import { defineConfig } from "eslint/config";
import globals from "globals";

import { reactConfig } from "./react.js";

/** For apps/mobile (Expo Router / React Native). */
export const expoConfig = defineConfig([
  ...reactConfig,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        __DEV__: "readonly",
      },
    },
  },
  {
    // Expo config files and Metro config run in Node.
    // `eas.json` is deliberately absent: it is data, not a script, and listing it
    // here makes ESLint parse JSON as JavaScript ("Parsing error: Unexpected token :").
    files: ["app.config.{js,ts}", "metro.config.js", "babel.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
]);

export default expoConfig;
