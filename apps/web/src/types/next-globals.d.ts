/**
 * Next.js normally writes these two reference directives into a generated
 * `next-env.d.ts`, which is gitignored and only exists after `next dev` or
 * `next build` has run at least once.
 *
 * `pnpm typecheck` has to pass on a clean checkout with no build output (that
 * is the CI gate), so the directives are duplicated here in a tracked file.
 * The generated `next-env.d.ts` remains harmless — duplicate `/// <reference>`
 * directives are idempotent.
 */

/// <reference types="next" />
/// <reference types="next/image-types/global" />
