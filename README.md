# PartyBooth

Private-beta party photo & video sharing. Guests scan a QR code, capture on their phone, the
organiser moderates, and approved media appears live on a slideshow.

- **[PLAN.md](PLAN.md)** — the spec: scope, decisions log, domain model, risks.
- **[TODO.md](TODO.md)** — the working tracker, one sprint per day up to the party on 5 Aug 2026.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — sprint cadence, commit convention, the CI gate.
- **[docs/](docs/README.md)** — product spec, domain model, glossary, [ADRs](docs/adr/README.md).

Everything below is the platform layer from **Sprint 1**.

## Quickstart

```bash
# Node 26 and pnpm 10 are required (see .nvmrc / packageManager).
corepack enable
pnpm install

cp .env.example .env.local     # then fill in what you have
pnpm env:doctor                # shows what is still unset, and where to get it

pnpm check                     # typecheck + lint + test, the CI gate
```

Nothing needs live credentials to typecheck or unit-test. Providers that are not configured
degrade to a no-op with a warning; a variable only ever throws when the code that needs it runs.

### Running the apps

```bash
pnpm --filter @partybooth/web dev      # http://localhost:3000
pnpm --filter @partybooth/mobile dev   # Expo dev server
```

Both boot with an empty environment. `apps/web` renders its authenticated shells behind a
"backend not configured" banner; `apps/mobile` shows a screen naming each missing variable.

Two env files, on purpose: the root `.env.local` covers the server and the web app, while
**Expo only reads env files sitting next to the app**, so mobile needs its own
`apps/mobile/.env.local` (see `apps/mobile/.env.example`). The root `.env.example` remains
the canonical list of every variable in the system — `pnpm env:doctor` reads it.

`packages/backend` has no deploy step in this sprint. `convex/_generated/` is committed so a
fresh clone typechecks offline; `npx convex dev` regenerates it once a real deployment exists.

## Commands

| Command           | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `pnpm dev`        | every app's dev server (Turborepo, persistent)         |
| `pnpm build`      | build everything in dependency order                   |
| `pnpm typecheck`  | root config files, then every package's `tsc --noEmit` |
| `pnpm lint`       | ESLint 10 flat config across the repo                  |
| `pnpm test`       | each package's Vitest suite (this is the CI gate)      |
| `pnpm test:watch` | one watch process spanning every package               |
| `pnpm format`     | Prettier write · `pnpm format:check` in CI             |
| `pnpm check`      | typecheck + lint + test in one go                      |
| `pnpm env:doctor` | diff the current environment against `.env.example`    |

Scope a command to one package with `--filter`:

```bash
pnpm --filter @partybooth/web dev
pnpm --filter @partybooth/env test
```

## Layout

```
apps/
  web/        @partybooth/web      Next.js App Router — organiser console, /admin, guest mobile web
  mobile/     @partybooth/mobile   Expo Router — camera, gallery, host tab
packages/
  backend/    @partybooth/backend            Convex schema + functions, Better Auth
  contracts/  @partybooth/contracts          shared zod schemas, permission rules, role types
  env/        @partybooth/env                typed, lazily-validated environment access
  config-typescript/  @partybooth/config-typescript   strict tsconfig presets
  config-eslint/      @partybooth/config-eslint       flat ESLint presets
```

Package names are `@partybooth/<dir>`. Depend on a sibling with `"workspace:*"`.

## Conventions every package follows

**Internal packages are consumed as TypeScript source.** There is no build step in `packages/*`
— `exports` point straight at `src/*.ts`. Consequences:

- Relative imports inside a package are **extensionless** (`./schema`, not `./schema.js`).
  That is what Metro, Turbopack, Vite and Convex's esbuild all resolve; a `.js` specifier would
  break Metro, and a `.ts` specifier is non-standard.
- `apps/web` must list internal packages in `transpilePackages`.
- Every package declares its own `tsconfig.json`, `eslint.config.mjs` and `vitest.config.ts`,
  plus `lint` / `typecheck` / `test` scripts so Turborepo can run them.

**TypeScript** — extend a preset from
[`@partybooth/config-typescript`](packages/config-typescript/README.md):
`base.json`, `library.json` (packages), `node.json` (Convex/scripts), `next.json`, `expo.json`.
Presets never declare `include`/`exclude`/`paths`; those are yours. Strict mode plus
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`,
`noUnusedParameters`.

**ESLint** — one line in your package:

```js
// eslint.config.mjs
import config from "@partybooth/config-eslint/next"; // or /node, /base, /react, /expo
export default config;
```

See [`packages/config-eslint/README.md`](packages/config-eslint/README.md). Note that reading
`process.env` outside `@partybooth/env` is a lint warning — that is deliberate.

**Prettier** — one config at the root (`prettier.config.mjs`); apps extend it rather than
redefining it. `eslint-config-prettier` is applied last so formatting is never a lint error.

**Domain rules come from `@partybooth/contracts`, never a local copy.** Roles, permissions,
state machines, join-code and invite-token formats, and the OTP policy have exactly one
definition and one set of tests. Import the **subpath** (`@partybooth/contracts/permissions`),
not the barrel, so a bundle only pulls in what it uses. Each app keeps its imports behind a
single seam file, which is the one place to edit when contracts moves:

| App           | Seam                                                              |
| ------------- | ----------------------------------------------------------------- |
| `apps/web`    | `src/lib/contracts.ts`                                            |
| `apps/mobile` | `src/lib/roles.ts` (permissions) · `src/lib/deep-links.ts` (join) |

A helper in a seam file may adapt shape — mobile's `RoleContext` is a view model, and its
join-code input is deliberately more lenient than the wire format — but must never make a
policy decision of its own. `apps/mobile/src/lib/roles.test.ts` asserts the adapter agrees
with the contracts capability matrix for every role, so a rule change there fails loudly
instead of letting a client drift from what Convex enforces.

**Dependency versions** — cross-cutting libraries live in the `catalog:` block of
`pnpm-workspace.yaml`. Write `"zod": "catalog:"` instead of pinning a version, so every package
moves together. Currently catalogued: `typescript`, `zod`, `vitest`, `@vitest/coverage-v8`,
`eslint`, `prettier`, `convex`, `@types/node`.

## Environment

`.env.example` is the single list of every variable the whole system needs, each with a one-line
note on where the value comes from. `.env*` is gitignored; only the example is tracked.

Read configuration through [`@partybooth/env`](packages/env/README.md) — never `process.env`:

```ts
import { serverEnv, serverFeatures } from "@partybooth/env/server";

if (!serverFeatures.resend) return { delivered: false }; // no-op, no crash
const key = serverEnv.RESEND_API_KEY; // clear error if unset
```

Values live in four places: `.env.local` for local dev, the **Convex dashboard** for backend
functions, **Vercel → Environment Variables** for the web app, and **EAS secrets** for app
builds. `pnpm env:doctor` tells you what is missing locally.

## Toolchain

Node 26 · pnpm 10 workspaces · Turborepo 2 · TypeScript 6 (strict) · ESLint 10 flat config ·
Prettier 3 · Vitest 4 · Zod 4.

TypeScript is pinned to the 6.x line rather than the 7.x native port: `typescript-eslint` still
declares `typescript <6.1` as its peer range, and a broken linter is not worth the compile speed
eight days before launch. Revisit after 5 Aug.

## CI

`.github/workflows/ci.yml` runs typecheck → lint → unit tests → format check on every push and
PR, with **no secrets**. If a change needs a live credential to pass CI, it is in the wrong place.
