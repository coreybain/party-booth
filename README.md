# PartyBooth

Private-beta party photo & video sharing. Guests scan a QR code, capture on their phone, the
organiser moderates, and approved media appears live on a slideshow.

- **[PLAN.md](PLAN.md)** — the spec: scope, decisions log, domain model, risks.
- **[TODO.md](TODO.md)** — the working tracker, one sprint per day up to the party on 5 Aug 2026.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — sprint cadence, commit convention, the CI gate.
- **[docs/](docs/README.md)** — product spec, domain model, glossary, [ADRs](docs/adr/README.md).

Everything below is the platform layer from **Sprints 1–2**.

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
| `pnpm seed:demo`  | seed the App Review demo party (needs the demo vars)   |
| `pnpm icons`      | regenerate the app icon set from source                |

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
  contracts/  @partybooth/contracts          shared zod schemas, permission rules, role types,
                                            the upload grant/ticket contract and capture pipeline
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

**The Convex wire contract has one description, and the backend owns it.**
`convex codegen` can only emit the generic `AnyApi` until a real deployment
exists to introspect, so `@partybooth/backend/client-api` hand-types the calls
the clients make and casts once. Both apps re-export from it behind a seam
(`apps/web/src/lib/convex-api.ts`, `apps/mobile/src/lib/api.ts`). Two copies of
that description would drift silently, because every mismatch is an `any`.

Because that description is an **assertion rather than a check**, anything a client
_branches on_ is re-parsed with a real schema at the call site: `parseJoinResult`
and `parseGrantResult` in `@partybooth/contracts`. Both fail closed — the next
thing that happens after reading a grant is that bytes get sent somewhere on the
strength of it.

**Dependency versions** — cross-cutting libraries live in the `catalog:` block of
`pnpm-workspace.yaml`. Write `"zod": "catalog:"` instead of pinning a version, so every package
moves together. Currently catalogued: `typescript`, `zod`, `vitest`, `@vitest/coverage-v8`,
`eslint`, `prettier`, `convex`, `@types/node`.

## Uploads and media

The upload spine is the highest-risk part of this product and the one with the most invariants, so
they are written down rather than implied. The long form is
[ADR 0004](docs/adr/0004-private-upload-pipeline.md) and
[`docs/domain-model.md`](docs/domain-model.md); the short form:

**A guest never holds a storage credential.** They ask Convex for a **grant** — short-lived (two
minutes), single-use, and bound to one exact file for one exact capture in one exact event. The
UploadThing route handler in `apps/web` is the only thing in the system holding an
`UPLOADTHING_TOKEN`, and the Expo app uploads _through_ it rather than around it.

**Every file has a private ACL, and every read is a permission-checked short-lived URL.** There is
no such thing as "the URL of a photo". Signed URLs last ten minutes and carry their `expiresAt` so a
client refreshes rather than serving a broken image. Withdrawal does not wait for expiry — the object
is deleted, which invalidates every outstanding URL immediately. Withdrawal is **permanent**.

**Location metadata is stripped at capture, by re-encoding, on the client.** The checksum is taken
over the re-encoded bytes, so the grant is minted against the stripped file. The claim records what
the pipeline actually did — it is never a hardcoded `true`.

Since Sprint 4 the claim is **two** booleans, because video broke the identity between them:
`sourceMetadataStripped` ("these bytes were re-encoded", which a **derivative grant requires**) and
`sourceCarriesNoLocation` ("these bytes carry no location", which the **read path** consults). For a
photograph they are the same fact; for a clip — which no client can transcode in the time a guest
will wait — they are not. Absent means "same as the re-encode claim", so nothing already stored
changed meaning. See `metadataClaimOf` in `@partybooth/contracts/media`.

**One capture is one submission, however many objects it is made of.** A photo is two files
(`original`, `preview`) and a video up to three (`original`, `poster`, `preview`), each with its own
bound single-use grant under the same `captureId`. Only the `original` pass creates the media row and
settles its state; a derivative attaches a key and stops — no counter, no state change — so a phone
that dies between the two never strands a capture. The `shared` tier in `DERIVATIVE_PROFILES` is
deliberately identical on both clients: it is the artefact third parties are served, and a photo
should not look different in the same grid depending on which app took it.
[ADR 0008](docs/adr/0008-client-produced-derivatives.md) is why the client makes them and the server
does not.

**The wire between clients and the route handler lives in contracts.** `uploadTicketSchema` and
`buildUploadTicket` in `@partybooth/contracts/upload`, and the capture arithmetic (`fitWithin`,
`toHex`, `newCaptureId`, `DERIVATIVE_PROFILES`) in `@partybooth/contracts/capture`. `apps/mobile`
does not depend on `apps/web`'s build, so a shape those two both need has to live in a package they
both import — a comment asking two people to keep two files in step is not a contract.

**Storage sits behind an adapter keyed on `event.storageRegion`.** `resolveStorageAdapter(region)` in
`packages/backend/convex/lib/storage/` is the only caller of the UploadThing SDK in the deployment.
The region always comes from the row, never from the environment, which is what makes "files never
migrate" true. Tests use an in-memory fake; a deployment with no token gets an adapter whose reads
omit the URL and whose deletes throw loudly.

**What degrades without credentials**, which is why all of this tests offline:

| Unset                    | What happens                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `UPLOADTHING_TOKEN`      | `/api/uploadthing` answers **503 naming the variable**; reads omit URLs |
| `UPLOAD_CALLBACK_SECRET` | completions are refused, so uploads never leave `processing`            |
| `CONVEX_URL`             | the middleware refuses before any bytes move                            |

Nothing throws at module scope, so `next build` and `expo export` both pass with an empty
environment. `media.storageStatus` (host-only) reports the flags, so a misconfiguration is
diagnosable from the organiser console rather than from a silent party.

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
