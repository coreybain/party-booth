import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  /**
   * `tsconfig.json` sets `jsx: "preserve"`, which Next.js requires and which
   * Vite otherwise honours — so importing any `.tsx` module from a test fails
   * to parse, even when the test only touches a plain function exported beside
   * the component. Overriding the transform here is what makes the
   * `*.test.tsx` entry in `include` below mean anything.
   *
   * `oxc` rather than `esbuild`: Vite 8 transforms with Rolldown/oxc and the
   * `esbuild` option is deprecated (and silently ineffective here).
   *
   * No DOM environment and no rendering library: those are real dependencies,
   * and PLAN.md puts browser-level testing in Sprint 6 behind Playwright. This
   * only unlocks the pure logic that lives next to a component.
   */
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
