# 0001. Monorepo, package manager and runtime baseline

- **Status:** Accepted
- **Date:** 28 Jul 2026
- **Sprint:** 1 — skeleton online

## Context

PartyBooth ships four surfaces against a **fixed party date eight days out**: a Next.js web app
(organiser console, `/admin`, guest mobile web), an Expo app, a Convex backend, and the shared
contracts that keep them honest. One developer builds all four, mostly in parallel with themselves.

Two forces dominate:

1. **Type safety across the seam is the main defence.** Permission rules, event and media state
   machines, upload-grant shapes and role types must be identical in the browser, on the phone and
   inside Convex functions. A drift between them is exactly the class of bug that surfaces at a party
   with fifty guests and no debugger.
2. **There is no time for build ceremony.** Any per-package compile step is latency on every edit and
   a source of stale-`dist` confusion, multiplied across three consumers with three different
   bundlers (Turbopack, Metro, Convex's esbuild).

Convex's region is immutable per deployment and was fixed at **US East (N. Virginia)** before this
decision, which is what makes it worth recording alongside the runtime.

## Decision

A single repository, **Bun 1.3 workspaces** over `apps/*` and `packages/*`, orchestrated by
**Turborepo 2**, on **Node 26** with **strict TypeScript**.

Four choices inside that are load-bearing:

- **Internal packages are consumed as TypeScript source.** No build step in `packages/*`; `exports`
  point straight at `src/*.ts`. Consumers transpile them (`transpilePackages` in Next.js, Metro's
  workspace resolution, esbuild in Convex). Relative imports inside a package are therefore
  **extensionless** — `./schema`, never `./schema.js` (breaks Metro) and never `./schema.ts`.
- **`linker = "hoisted"`.** A flat `node_modules` is Expo's documented remedy for Bun monorepos,
  and it keeps Metro, Turbopack and Convex's resolver out of symlink trouble. We give up Bun's
  strict phantom-dependency protection to get it.
- **A Bun `catalog:`** is the single source of truth for cross-cutting versions — `typescript`,
  `zod`, `vitest`, `eslint`, `prettier`, `convex`, `@types/node`. Packages write `"catalog:"` instead
  of a range, so the repo moves as one.
- **TypeScript pinned to the 6.x line**, not the 7.x native port: `typescript-eslint` still declares
  `typescript <6.1` as its peer range. A working linter beats faster compiles this week.

Environment access goes through `@partybooth/env`, which validates **lazily, per variable, on first
read** — so a missing Resend key is an error in the mail path and nothing at all in the camera path.
Reading `process.env` anywhere else is a lint warning. This is what lets the whole repo typecheck and
unit-test with **zero credentials**, which is in turn what lets CI run with **no secrets**.

`bun run check` — typecheck, lint, unit tests — is the gate, and CI runs exactly that.

## Consequences

**Easier.** One `bun install`. One atomic commit can change a Convex validator, the contract and
both clients. Editor go-to-definition lands in real source, not a `.d.ts`. Turborepo caches by task
so an unchanged package is replayed rather than rerun. New contributors get one command to trust.

**Harder, and accepted.**

- **Consumers must be told to transpile.** `apps/web` has to list internal packages in
  `transpilePackages` or Next.js will choke on untranspiled TS in `node_modules`. This is a real
  footgun for whoever adds the next package; it is documented in the root `README.md`.
- **`EXPO_PUBLIC_*` inlining does not reach workspace packages.** `babel-preset-expo` substitutes
  those literals only in app source, and to Metro a workspace package is inside `node_modules`.
  `apps/mobile` therefore calls `createMobileEnv({ … })` from its **own** source, passing the
  literals in. Non-obvious, and it will bite anyone who forgets.
- **Hoisting lets phantom dependencies compile.** A package can import something it never declared
  and CI will pass. We trade that for bundler sanity.
- **Publishing any of these packages later means adding a build step**, because raw TS in `exports`
  is only viable for private consumers. Not a concern for a private beta.
- **Node 26 and Bun 1.3 are hard requirements** (`.nvmrc`, `packageManager`, `engines`). CI reads
  `.nvmrc` so there is one place to change it.

## Alternatives considered

| Option                                          | Why not                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate repos per surface, shared types on npm | Publishing a package to change a permission rule, eight days from a party. Version skew between phone and server is the exact failure to avoid. |
| Other workspace package managers               | Bun provides both the `catalog:` and workspace protocols while retaining the hoisted layout required by the app bundlers.                       |
| Nx instead of Turborepo                         | More capability than a four-package repo needs; Turborepo's `turbo.json` is small enough to read in one sitting.                                |
| Build internal packages to `dist/` with tsup    | An extra watcher per package and a whole class of stale-artefact bugs, for no benefit while every consumer already transpiles.                  |
| `@t3-oss/env-core` for environment validation   | Validates eagerly at `createEnv()`. That fails the offline requirement — the repo must typecheck and test with an empty `.env`.                 |
| TypeScript 7.x native port                      | `typescript-eslint@8` peer-caps at `<6.1`. Revisit once that lands.                                                                             |
| `exactOptionalPropertyTypes: true`              | Constant friction with React props and Convex validators for little value this sprint. Every other strict flag is on.                           |

## Revisit when

- After **5 Aug 2026**: TypeScript 7 once `typescript-eslint` supports it.
- If a second developer joins and phantom dependencies start costing real time, reconsider
  `linker = "hoisted"` — likely by narrowing it to `apps/mobile` via `publicHoistPattern`.
- If any package needs to be consumed outside this repo, it needs a build step first.
