/**
 * Shared Prettier configuration for the PartyBooth monorepo.
 *
 * Apps may extend this (e.g. apps/web adding prettier-plugin-tailwindcss) with:
 *
 *   import base from "../../prettier.config.mjs";
 *   export default { ...base, plugins: [...(base.plugins ?? []), "prettier-plugin-tailwindcss"] };
 *
 * @type {import("prettier").Config}
 */
const config = {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [
    {
      files: ["*.md", "*.mdx"],
      options: { proseWrap: "preserve" },
    },
    {
      files: ["*.json", "*.jsonc", "*.json5"],
      options: { trailingComma: "none" },
    },
  ],
};

export default config;
