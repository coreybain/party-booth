import { defineConfig } from "vitest/config";

/**
 * Root Vitest configuration.
 *
 * `vitest.workspace.ts` was removed in Vitest 4 — projects live here instead.
 * Each workspace package owns a `vitest.config.ts`; globbing the config files
 * (rather than the directories) means a package without tests yet is simply
 * not a project, so `bun run test:watch` keeps working while apps are scaffolded.
 *
 * `bun run test` (Turborepo) is the CI gate and runs each package's own `test`
 * script; this file exists for a single watch process across the whole repo.
 */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/.expo/**",
        "**/*.config.*",
        "**/convex/_generated/**",
      ],
    },
  },
});
