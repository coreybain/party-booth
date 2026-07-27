import { defineConfig } from "vitest/config";

/**
 * Unit tests for apps/mobile.
 *
 * Scope is deliberately limited to `src/lib` — the pure modules with no React Native
 * imports. Rendering React Native components under Vitest needs a Metro-equivalent
 * transform pipeline (Flow types in react-native's own source, native module mocks),
 * which is a poor trade a week before launch. Component behaviour is covered by the
 * physical-device passes in Sprint 6; what is unit-tested here is the logic that is
 * genuinely easy to get wrong: deep-link parsing, permission rules, config resolution
 * and Sentry scrubbing.
 */
export default defineConfig({
  test: {
    name: "mobile",
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
