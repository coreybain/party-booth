import { defineConfig } from "vitest/config";

/**
 * Unit tests for apps/mobile.
 *
 * Scope is deliberately limited to the pure modules with no React Native imports:
 * `src/lib` (deep-link parsing, permission rules, config resolution, Sentry
 * scrubbing) and `src/upload` (the queue reducer, its persistence format, the undo
 * countdown, the retry policy and the derivative arithmetic).
 *
 * Rendering React Native components under Vitest needs a Metro-equivalent transform
 * pipeline (Flow types in react-native's own source, native module mocks), which is
 * a poor trade a week before launch. Component behaviour is covered by the physical-
 * device passes in Sprint 6.
 *
 * That split is why `src/upload` is shaped the way it is: everything a durable queue
 * can get wrong — a transition that should not be legal, a backoff that resets, a
 * row written by an older build — is decided in a function that takes `now` as an
 * argument and touches no Expo module.
 */
export default defineConfig({
  test: {
    name: "mobile",
    environment: "node",
    include: ["src/lib/**/*.test.ts", "src/upload/**/*.test.ts"],
  },
});
