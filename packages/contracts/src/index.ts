/**
 * `@partybooth/contracts` — the shared vocabulary.
 *
 * Everything in here is **pure**: no I/O, no Convex, no React, no Node
 * built-ins. `apps/web`, `apps/mobile` and `packages/backend` all import it, so
 * a permission rule or a state machine has exactly one definition and one set
 * of tests.
 *
 * Consumed as TypeScript source (no build step) — `apps/web` must list
 * `@partybooth/contracts` in `transpilePackages`.
 */

export * from "./accounts";
export * from "./analytics";
export * from "./capture";
export * from "./codes";
export * from "./copy";
export * from "./events";
export * from "./join";
export * from "./media";
export * from "./otp";
export * from "./permissions";
export * from "./qr";
export * from "./roles";
export * from "./schemas";
export * from "./scrub";
export * from "./state-machine";
export * from "./storage";
export * from "./terms";
export * from "./upload";
export * from "./video";
