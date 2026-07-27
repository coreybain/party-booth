# Contributing

Read [`README.md`](README.md) first for the toolchain and layout. This file covers how work is
sequenced, how commits are written, and what has to be true before anything merges.

Until **5 August 2026** this is a one-week launch sprint. The rules below are tuned for that: fast,
offline-verifiable, and biased towards a thing you can open on a phone tonight.

## Cadence

[`TODO.md`](TODO.md) is the working tracker. **One sprint per day**, each ending in a **releasable
checkpoint (RC)** — something deployed that you open on a real phone that evening.

| Sprint | Day        | Theme                                       | RC                                                |
| ------ | ---------- | ------------------------------------------- | ------------------------------------------------- |
| 1      | Tue 29 Jul | Skeleton online                             | OTP email → authenticated shell; Expo build opens |
| 2      | Wed 30 Jul | Events & joining                            | Scan a QR, sign in, land in the event             |
| 3      | Thu 31 Jul | The upload spine — **highest risk**         | Photo lands as `pending` within seconds           |
| 4      | Fri 1 Aug  | Moderate, watch, **submit iOS** ⚠️          | Fake mini-party: upload → approve → slideshow     |
| 5      | Sat 2 Aug  | Hosts, rotation, push, admin                | Co-host moderates; rotation kills the old QR      |
| 6      | Sun 3 Aug  | Harden + **dress rehearsal** 🎪             | Rehearsal completes end-to-end unaided            |
| 7      | Mon 4 Aug  | Freeze & stage — **feature freeze at noon** | Fresh phone: paper QR → contributing in 90 s      |

Two dates are not negotiable: **the iOS submission at the end of Friday 1 Aug**, and **feature
freeze at noon on Monday 4 Aug**. After the freeze, config and copy only.

A sprint is done when its RC is **verified**, not when the code is written. If an RC will not make
it, cut scope rather than the checkpoint — [`PLAN.md`](PLAN.md) records the pre-agreed cut orders,
and the guest **web** path outranks everything native.

Post-launch reverts to a weekly cadence, releasable each Friday (P1–P5 in `TODO.md`).

## Commit messages

Prefix every commit with a bracketed type:

```
[new feature] Issue single-use upload grants from Convex
[fix] Reject joins against a superseded inviteVersion
[style] Align moderation grid gutters on narrow viewports
```

| Prefix          | For                                                                      |
| --------------- | ------------------------------------------------------------------------ |
| `[new feature]` | new user-visible capability, or new infrastructure that enables one      |
| `[fix]`         | something was wrong and now is not — bugs, security holes, broken builds |
| `[style]`       | visual and formatting change only, no behaviour change                   |

Rules:

- Imperative mood, capitalised, no trailing full stop. Aim for ≤ 72 characters.
- Say **what changed and why**, not which files you touched — the diff already has those.
- One logical change per commit. If the subject needs "and", it is two commits.
- **Read the diff line by line before committing.** `git add -p` and `git diff --staged` are the
  minimum bar. This is a stated convention in `PLAN.md`, not a nicety: a stray `console.log` of an
  OTP or a hardcoded key is the kind of thing that gets committed at 1 a.m.
- Body paragraphs are welcome for anything non-obvious. Reference the sprint line you are closing.

## Branches and pull requests

Work on a branch, open a PR, let CI run. Branch names: `feat/upload-grants`, `fix/join-rate-limit`,
`chore/ci-cache`.

The PR template asks for the sprint line and the RC this moves. Keep PRs small enough to read in one
sitting — during launch week, a PR that sits overnight is a PR that blocks tomorrow's sprint.

## The gate

```bash
pnpm check          # typecheck + lint + unit tests, across every package
pnpm format         # then let Prettier have the last word
```

Both must pass before you push. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every
push to `main` and every PR and does the same four things —
`pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm format:check` — as separate steps, so one push
tells you everything that is wrong rather than one problem per round-trip. The root scripts also
cover the repo-level config files that `pnpm check` skips, which is why CI calls them individually.

**CI has no secrets, and that is a design constraint, not an oversight.** Everything in this repo
typechecks and unit-tests **fully offline**, with an empty environment. If a change only passes with
a live credential, the change is in the wrong place — move the credential behind
`@partybooth/env`'s feature flags so the code path no-ops when it is absent.

Formatting is Prettier's problem, not yours: `pnpm format` before you push, and never argue with it.
`PLAN.md` and `TODO.md` are in `.prettierignore` because they are the owner's documents.

## Rules that matter more than they look

**Never `process.env`.** Read configuration through `@partybooth/env` — `serverEnv`, `clientEnv`,
`createMobileEnv` — and gate optional providers on `serverFeatures.*` so an unconfigured provider
degrades to a no-op instead of a crash. Direct `process.env` access outside `*.config.*` and
`scripts/` is a lint warning on purpose.

**Adding an environment variable means two files**, always in the same commit:
`packages/env/src/schema.ts` and `.env.example`, with a real "where do I get this" hint. Tests fail
if the two drift, if a public variable is missing its `NEXT_PUBLIC_` / `EXPO_PUBLIC_` prefix, or if
the hint is too vague to act on. Run `pnpm env:doctor` to see what is still unset locally.

**Never commit a secret.** `.env*` is gitignored except the example; `*.p8`, `*.p12`, `*.jks` and
`*.key` are gitignored outright. If one lands in a commit, rotate the credential — do not just amend.

**Cross-cutting dependency versions go in the `catalog:`** block of `pnpm-workspace.yaml`. Write
`"zod": "catalog:"` in a package, not a range. Writing `catalog:` for something not yet catalogued
fails the install; add it to the catalog first.

**Relative imports inside a package are extensionless** — `./schema`, never `./schema.js` (breaks
Metro) and never `./schema.ts`. Internal packages are consumed as TypeScript source; see
[ADR 0001](docs/adr/0001-monorepo-runtime.md).

**Every package exposes `lint`, `typecheck` and `test` scripts** so Turborepo can find them, plus
`build` and `dev` for apps.

## Tests

The bar is focused, not comprehensive — [`PLAN.md`](PLAN.md) sets it deliberately. What must have
unit tests, because these are the things that fail silently and expensively:

- **Permission rules** — every cell of the matrix in [`docs/domain-model.md`](docs/domain-model.md).
- **State transitions** — event, media and account machines, including the illegal transitions.
- **Grant validation** — expiry, single use, and the event/size/type it was issued for.
- **Callback idempotency** — a completion callback arriving twice, or out of order, changes nothing.
- **Join protection** — rate limits, and responses that do not distinguish "no such event" from
  "wrong version" from "not live".

Beyond that: one Playwright happy path, security spot-checks, and a two-phone manual pass in Sprint 6. Everything a machine can check runs offline.

## Documentation

Update the docs in the PR that changes the behaviour, not afterwards:

| You changed                            | Update                                         |
| -------------------------------------- | ---------------------------------------------- |
| an entity, a state, a permission       | [`docs/domain-model.md`](docs/domain-model.md) |
| what the product does or who can do it | [`docs/product-spec.md`](docs/product-spec.md) |
| introduced or renamed a concept        | [`docs/glossary.md`](docs/glossary.md)         |
| something expensive to reverse         | a new ADR — [`docs/adr/`](docs/adr/README.md)  |

Those docs describe intent; the code is the source of truth. When they disagree, the doc is the bug.

Write an ADR when the decision is costly to undo, when you will be asked "why not X?" more than
once, or when you are knowingly accepting a downside. Copy
[`docs/adr/0000-template.md`](docs/adr/0000-template.md) and add a row to the index. ADRs are never
edited into a different decision — supersede them with a new one.

## What not to do

- No `convex deploy`, `vercel deploy` or EAS builds from an agent or a CI job — releases are driven
  by the owner.
- No live credentials in code, tests, fixtures or examples. Not even fake-looking real ones.
- No new tooling during launch week unless it removes more work than it adds today.
- No refactors bundled into a feature commit. Land the feature, refactor separately, keep the diff
  readable at 1 a.m.
