# 0011. Bun 1.3 is the package manager and script runner, with the linker pinned to hoisted

- **Status:** Accepted
- **Date:** 30 Jul 2026
- **Sprint:** 2 — events & joining by the calendar in [`TODO.md`](../../TODO.md), though the work
  landed on top of the Sprint 5 merge and has nothing to do with events or joining
- **Supersedes:** [ADR 0001](0001-monorepo-runtime.md)

## Context

[ADR 0001](0001-monorepo-runtime.md) fixed the shape of this repository on 28 Jul: one repo,
workspaces over `apps/*` and `packages/*`, Turborepo 2, Node 26, strict TypeScript, internal
packages consumed as TypeScript source and a flat `node_modules`. It named **pnpm 10** as the
package manager. Two days later, and six days from a hard party date of **5 Aug 2026**, the package
manager became Bun. This ADR records that change; 0001 records what was decided on 28 Jul and is
superseded, not rewritten.

**The migration was a single commit, and it was not scoped to the migration.** `8d2b86b` touched 123
files. The migration part deleted `pnpm-lock.yaml` (11,534 lines) and `pnpm-workspace.yaml`, added
`bun.lock` (2,559 lines) and `bunfig.toml`, and rewrote `turbo.json`, `.github/workflows/ci.yml` and
the root scripts that named `node` or `pnpm`. The rest was unrelated: 38 files under
`packages/backend/convex/` and two new Radix dependencies in `apps/web/package.json`. It also
deleted `.env.example` — which `turbo.json` lists in `globalDependencies` and
`scripts/env-doctor.mjs` hard-requires — and that had to be repaired afterwards by `e6a777a`. Its
diff is a mixed bag, not a migration record, which is part of why this ADR exists.

**Nothing 0001 argued for depended on pnpm.** Its four load-bearing choices were TypeScript-source
internal packages, a flat `node_modules`, one catalog for cross-cutting versions, and TypeScript
pinned to the 6.x line. pnpm was the tool that happened to deliver the middle two. Bun delivers both
as well, though — as below — it delivers the flat tree only when told to.

**An audit recommended deferring this until after 5 Aug**, on the grounds that a package-manager
change in launch week buys nothing the party needs. It was done during launch week anyway. The
trade-off is recorded under Alternatives rather than argued away.

## Decision

**Bun 1.3.14** is the package manager and script runner for the whole repository, pinned in
`packageManager` and in CI. Everything else in ADR 0001 stands unchanged: internal packages are
still consumed as TypeScript source with extensionless relative imports, `node_modules` is still one
flat tree, cross-cutting versions still come from a catalog, TypeScript is still pinned to 6.x, and
Node 26 is still the runtime. Only the tool changed.

- **`linker = "hoisted"` is pinned explicitly, in `bunfig.toml`.** Bun's documented default for a
  workspace is the **isolated** linker — a symlinked virtual store under `node_modules/.bun` — so a
  repo migrating off a pnpm lockfile does not get a flat tree unless it asks for one. `bunfig.toml`
  asks, in one line, and `bun.lock` records `configVersion: 1`. So the tree that Metro, Turbopack
  and Convex's esbuild resolve through is not a Bun default — it is that line. Pinning it opts out
  of the isolated linker's phantom-dependency protection, exactly as `nodeLinker: hoisted` opted out
  of pnpm's. Reproducing the flat tree from a clean checkout is on the Revisit list; it has not been
  done, so the pin's effect is argued from Bun's documented behaviour and from the tree in place,
  not from an observed clean install.
- **The catalog and the workspace globs moved into the root `package.json`.** `pnpm-workspace.yaml`
  is gone; `workspaces` carries `apps/*` and `packages/*`, and a top-level `catalog` block carries
  all nine entries at byte-identical ranges. Packages still write `"catalog:"` and still depend on
  each other with `workspace:*`, so no `packages/*/package.json` had to change at all. Bun genuinely
  consumes both: `bun.lock` records the catalog and the literal `catalog:` specifiers it resolved.
- **`trustedDependencies` replaces pnpm's `onlyBuiltDependencies`,** copied across verbatim. Of the
  six names, only `@sentry/cli` can matter: `esbuild` and `sharp` are on Bun's default-trusted list,
  and `@swc/core`, `core-js` and `unrs-resolver` have no resolved entry in `bun.lock` — `@swc/core`
  appears only as an optional peer of `minimizer-webpack-plugin`, `core-js` only as `core-js-compat`
  — so their postinstalls cannot run, and could not under pnpm either. The list is inherited, not
  derived, and is on the Revisit list.
- **Node 26 stays, and stays installed in CI.** Bun installs and runs scripts; Node runs
  `next build`, Expo and EAS, and the postinstall scripts themselves — `@sentry/cli`'s is literally
  `node ./scripts/install.js`. CI keeps `actions/setup-node@v7` reading `.nvmrc` beside
  `oven-sh/setup-bun@v2` at `bun-version: 1.3.14`.
- **The gate is `bun run check` — typecheck, lint, unit tests.** CI runs those three as separate
  always-run steps rather than the aggregate, and adds `bun run format:check` and a no-secrets
  `bun run build`. That build step is `turbo run build` with no filter, so it covers both
  `next build` and, through `apps/mobile`, `expo export --platform all` — a Metro bundle of both
  platforms on every run. It is always `bun run test`, never `bun test`: 104 files import from
  `vitest` and six `vitest.config.ts` files supply the environment, including `edge-runtime` for
  `packages/backend`. Bun's own test runner reads none of them.

## Consequences

**Easier.** One tool for installing and running scripts where there were two — Bun replaces pnpm for
installs and `node` for the four repo scripts that used to shell out to it. Two runtimes are still
installed everywhere, by design: Node remains in CI and on every machine for `next build`, Expo and
EAS. Bun should install cold much faster than pnpm did, and that is the practical reason the swap
was thought worth making — but it is an expectation, not a measurement. No cold install has been
timed under either tool in this repo, and none has been run under Bun at all (see below). Because
`catalog:` and `workspace:*` port over unchanged, no `packages/*/package.json` needed editing.

**Harder, and accepted.**

- **The flat layout rests on one line of config, and the gate does not check it.** If
  `bunfig.toml`'s `linker` is deleted, shadowed by `--linker=isolated`, or lost in a merge, then
  `bun install` still exits 0, `bun run typecheck` still passes and every unit test still passes —
  Vitest resolves through Node's symlink-tolerant algorithm. So `bun run check`, the one command
  this repo tells you to trust, goes green on a tree the native app may not bundle. What does catch
  it is CI's Build step, which reaches `expo export --platform all`, so a Metro resolution failure
  surfaces there rather than days later in an EAS build. The residual exposure is local, not
  shipped: someone who runs only `bun run check` before pushing sees nothing wrong, and CI is the
  first thing that objects.
- **Nothing enforces the toolchain at install time.** `engines` and `packageManager` are advisory
  here — nothing in the repo checks either before an install, and there is no `preinstall` guard.
  Under pnpm, `engines.pnpm` gave at least some protection. A stale local Bun, or someone typing
  `npm install`, now produces a tree nothing checks. Exactly how much of `engines` Bun 1.3.14
  enforces was not established; the point stands either way, because no guard in this repo depends
  on it.
- **`node_modules` has never been built from scratch by Bun.** It still carries pnpm-era artefacts
  (`node_modules/.modules.yaml`, `node_modules/.pnpm/lock.yaml`), so the flat tree observed today is
  a hybrid and is **not** evidence that a clean install reproduces it. Only `bunfig.toml` guarantees
  that, and it has not been demonstrated end to end.
- **The lockfile was regenerated from the registry, not converted, and the drift is wider than one
  package path.** Comparing `bun.lock` against the deleted `pnpm-lock.yaml` package by package, **37
  packages resolve to different versions**: 17 minor bumps, 17 patch-level changes or extra
  duplicate copies, and three packages that lost a resolution outright. The minors are the whole
  14-package `@sentry/*` stack at 10.68.0 → 10.69.0 — which includes **`@sentry/nextjs`, a direct
  dependency** declared `^10.68.0` in `apps/web/package.json`, so this is not purely transitive
  drift — plus `@napi-rs/wasm-runtime` 1.1.6 → 1.2.0, `@testing-library/jest-dom` 6.9.1 → 6.10.0
  and `acorn` 8.17.0 → 8.18.0. Six `@react-native/*` packages moved 0.86.0 → 0.86.2, among them
  `@react-native/babel-preset` and `@react-native/metro-babel-transformer` — the React Native
  Babel/Metro path. And `hermes-parser`, `hermes-estree` and `babel-plugin-syntax-hermes-parser` all
  lost their 0.36.1 resolution: `0.36.1` appears nowhere in `bun.lock`. Nothing was reviewed package
  by package; a green suite is the whole verification.
- **ADR 0001's zero-credentials guarantee is now weaker locally, and how much weaker depends on the
  script.** Bun auto-loads `.env.local` into the process it starts, so anything run directly under
  Bun sees real credentials in `process.env`. `bun run test` is `turbo run test`, and `turbo.json`
  sets no `envMode`, so Turborepo's strict default applies: the `test` task declares no `env`, so
  the Vitest child gets only `globalEnv` plus `globalPassThroughEnv` — which means
  **`CONVEX_DEPLOY_KEY` and `SENTRY_AUTH_TOKEN` do reach tests, while `UPLOADTHING_*` (the
  `sk_live_` key) and `BETTER_AUTH_*` do not.** The scripts that see everything are `test:watch` and
  `test:coverage`, which invoke `vitest` directly and bypass Turborepo's filter entirely. So a test
  that leans on a live UploadThing key fails locally too, but one leaning on a Convex deploy key
  passes locally and fails only in CI. `bun run env:doctor` is collateral: its provenance column now
  labels every `.env.local`-only variable `(process.env)`, because Bun merged the file in before it
  started.
- **Two env-resolution rules live in one `package.json`.** Five scripts — `dev`, `build`, `start`,
  `start:web` and `start:mobile` — pass `--env-file=.env.local`, which switches Bun's automatic
  loading **off** rather than adding to it, so those five read that file and nothing else. The gate
  scripts pass no flag and auto-load `.env`, `.env.local` and `.env.<NODE_ENV>`. No tracked `.env`
  exists today, so nothing is broken; the trap is set for whoever adds one.
- **The Turborepo cache now hangs off the root `package.json`.** The catalog lives there, so
  `package.json` had to join `bun.lock` and `bunfig.toml` in `globalDependencies` — where
  `pnpm-workspace.yaml` was one file that rarely changed, any script tweak now busts every task
  hash. CI also lost its package-manager cache with `cache: pnpm` and gained no Bun replacement, so
  every run re-downloads the graph. Slower, not incorrect.
- **Phantom dependencies still compile**, unchanged from 0001, and two Reacts still coexist in the
  flat tree by design — 19.2.3 hoisted at the root for React Native, 19.2.8 nested under `apps/web`
  for Next. Correct, intentional, and exactly the failure mode hoisting makes possible if the
  hoisting winner ever flips.

## Alternatives considered

| Option                                                       | Why not                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay on pnpm 10, as ADR 0001 decided                         | The closest call here, and nothing was wrong with pnpm. Bun replaces two tools with one for install and script-running, and `catalog:` plus `workspace:*` port over untouched, so the change is small. The expected faster cold install was the draw, but it was never measured. Against it: an audit recommended deferring until after 5 Aug. |
| npm or Yarn workspaces                                       | Neither has a catalog worth the name, so the single source of truth for `typescript`, `zod` and `vitest` versions would have to be rebuilt by hand. Familiarity does not pay for that.                                                                                                                                                         |
| Bun with its default isolated linker                         | It symlinks dependencies into `node_modules/.bun` instead of laying them out flat, which is precisely the symlink trouble ADR 0001 bought the flat tree to avoid. A resulting failure would surface in CI's Build step, which bundles the native app, but never in the `bun run check` gate.                                                   |
| Bun as the test runner and runtime too, not just Bun install | `bun test` ignores all six `vitest.config.ts` files, including the `edge-runtime` environment `packages/backend` needs, and cannot serve the `vitest` imports 2,073 tests are written against. Rewriting the suite six days out is not a trade.                                                                                                |
| Convert the pnpm lockfile rather than re-resolve             | Bun cannot read pnpm's lockfile format, so `bun install` re-derives resolution from the registry. The 37-package drift was accepted, not avoided.                                                                                                                                                                                              |
| Prune `trustedDependencies` in the same commit               | A postinstall allowlist is the last thing to shorten the week of a store build: an entry that does nothing costs nothing, and one that turns out to have mattered costs a Sentry source-map upload inside a release build. Left until after the party.                                                                                         |
| Add a `preinstall` guard rejecting non-Bun installs          | It is the right fix for the missing enforcement and it is on the Revisit list. A guard hand-rolled in launch week that misfires blocks every install, CI's included, which is a worse failure than the one it prevents.                                                                                                                        |

## Revisit when

- **Before 5 Aug 2026:** run `rm -rf node_modules && bun install` on a clean checkout and then bundle
  the native app. That is the only thing that proves the flat tree reproduces from `bunfig.toml`
  alone, and it has not been done — today's `node_modules` is a pnpm/Bun hybrid. Time that install
  while you are there, so the performance claim behind this decision stops being an assumption.
- **If phantom dependencies or the duplicate React start costing real time:** note that Bun's
  `linker` is `hoisted` or `isolated` and nothing in between. There is no per-package hoist
  allowlist, so pnpm's `publicHoistPattern` escape hatch — the one ADR 0001 nominated for exactly
  this — has no Bun equivalent. Revisiting means taking the isolated tree whole and proving Metro,
  Turbopack and Convex's esbuild all resolve through it. Not before the party.
- **After 5 Aug 2026:** re-derive `trustedDependencies` from `bun.lock` rather than from pnpm's old
  list, review the 37 drifted resolutions — starting with the Hermes parser trio and the
  `@sentry/nextjs` minor — and add a Bun install cache to CI to replace the `cache: pnpm` that was
  dropped.
- **If a second developer joins:** the missing install-time guard becomes the first thing to fix,
  because nothing in this repo checks the package manager before an install and a wrong tool fails
  silently.
