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
    files: ["app.config.{js,ts}", "metro.config.js", "babel.config.js", "eas.json"],
    languageOptions: { globals: { ...globals.node } },
  },
]);

export default expoConfig;
