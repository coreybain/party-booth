# `@partybooth/backend`

The Convex deployment: schema, Better Auth wiring, guards and the audit log.
Convex functions live in `convex/`; `src/index.ts` exports only what a client
needs to interpret a response (error codes, schema-local enums). Domain types
come from `@partybooth/contracts`.

```ts
import { api } from "@partybooth/backend/api";
const user = useQuery(api.users.currentUser);
```

## Working offline

Everything typechecks and tests with **no credentials and no deployment**.

`convex/_generated/` is committed. It was produced by `convex codegen` without a
deployment, which yields:

- `dataModel.d.ts` — **fully typed** from `schema.ts`. Tables, documents and
  indexes are all real.
- `api.d.ts` — the _generic_ fallback (`AnyApi`, `AnyComponents`). Function
  references are permissive rather than precise.

That is the standard pre-`convex dev` state and it is enough to build against.
It costs two casts in `auth.ts` (`internal.auth`, `components.betterAuth`),
commented where they are. Once Corey runs `npx convex dev` against a real
project, codegen replaces these files with precise versions and the casts become
no-ops.

Regenerating without a deployment (the CLI insists on _some_ deployment
configuration, but the bundling and codegen steps are local — it only fails at
the final network fetch, after the files are written):

```bash
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY='offline|0000' \
pnpm --filter @partybooth/backend exec convex codegen --typecheck disable
```

The command **exits non-zero** — it retries the fetch six times and gives up. That is
expected; check `git status` rather than the exit code. Verified during integration: the
files it writes are byte-identical to the committed ones.

Once there is a real project, just `pnpm --filter @partybooth/backend dev`.

## Layout

```
convex/
  schema.ts            schema v1 — every Sprint 1 table
  convex.config.ts     registers the Better Auth component
  auth.config.ts       tells Convex to trust Better Auth's JWTs
  auth.ts              component client, user-mirroring triggers, createAuth
  http.ts              mounts Better Auth at /api/auth/*
  users.ts             currentUser query
  otp.ts               registerSend — the transactional OTP send throttle
  lib/
    validators.ts      Convex validators derived from @partybooth/contracts
    guards.ts          requireUser / requireEventActor / requirePermission
    audit.ts           the append-only audit writer
    account-deletion.ts  deletionScheduled + deletionJobs + audit, idempotent
    errors.ts          ConvexError payloads with machine-readable codes
    config.ts          base URLs, admin allowlist, demo login
    otp.ts             OTP policy → Better Auth options
    providers.ts       Google / Apple, each optional
    sentry.ts          envelope reporter, scrubbed via @partybooth/contracts
    email/             EmailSender interface, Resend + console implementations
```

Files with two dots in the name (`*.test.ts`, `auth.config.ts`) are skipped by
the Convex bundler's entry-point scan, so tests sit next to the code without
being deployed. The convex-test suites (`convex/guards.test.ts`,
`convex/audit.test.ts`) live at the root of `convex/` because convex-test finds
the module map relative to `_generated`, and pnpm's hoisted `node_modules`
defeats its automatic discovery — they pass `import.meta.glob` explicitly.

## Auth

Better Auth runs **inside Convex**, mounted on the Convex _site_ URL
(`https://<name>.convex.site/api/auth/*`). `BETTER_AUTH_URL` should equal
`CONVEX_SITE_URL`; `SITE_URL` is the Vercel app, and both are trusted origins
along with the `partybooth://` app scheme.

Better Auth owns its own `user` / `session` / `account` / `verification` tables
inside the component. Our `users` table is a mirror kept in step by the `user`
trigger in `auth.ts` — created, updated and soft-deleted alongside it. Mirroring
on a trigger rather than lazily matters because queries cannot write: by the
time any read path runs, the row exists.

Identity flows `ctx.auth.getUserIdentity().subject` → `users.authId` → our row.
Guards go through our table, not the component, so they can see `accountState`.

### Degrading without credentials

| Missing                                | Behaviour                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`                   | **Every auth request fails, loudly.** This is deliberate — see below.                                                                                                                                                                |
| `DEPLOYMENT_ENVIRONMENT`               | Treated as `development`: the console email sender is allowed to report success. Set it to `production` on the real deployment or OTP delivery silently becomes a log line.                                                          |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | On a `development` deployment, OTP emails print to the Convex logs — recipient and subject only, unless `EMAIL_DEBUG_LOG_CODES=1`. Anywhere else the send **fails** rather than faking a success. A malformed key counts as missing. |
| `GOOGLE_CLIENT_ID` / `_SECRET`         | Google provider is not registered. Email OTP still works.                                                                                                                                                                            |
| `APPLE_CLIENT_ID` / bundle id          | Apple provider is not registered.                                                                                                                                                                                                    |
| `ADMIN_EMAIL_ALLOWLIST`                | Nobody is an admin. A _malformed_ value is ignored with a loud log rather than throwing — a typo must not take down sign-in on party night.                                                                                          |
| `DEMO_LOGIN_*`                         | No reviewer bypass exists.                                                                                                                                                                                                           |
| `SENTRY_DSN`                           | Error reporting is a no-op; errors fall back to a **scrubbed** `console.error`.                                                                                                                                                      |

### `BETTER_AUTH_SECRET` is the one variable that must not degrade

`createAuth` passes `secret: serverEnv.BETTER_AUTH_SECRET` explicitly, and
`@partybooth/env` throws for a missing or too-short value. That is on purpose.

Left unset, Better Auth resolves the secret itself and falls back to a
hard-coded constant that is published in its own source. Its guard against
shipping that is `NODE_ENV === "production"` — and **Convex never sets
`NODE_ENV`**, so the guard is dead code here. A deployment with a typo'd secret
would boot happily and sign every session cookie and Convex identity JWT with a
value anyone can read off npm, which is enough to mint a session for an
arbitrary `authId` and walk straight past `requireGlobalAdmin`.

Failing at the first auth request is the cheap outcome. Set it in the Convex
dashboard, and set the same value in Vercel.

### Rate limiting and the OTP send ceiling

Two brakes, because Better Auth's own one cannot be trusted inside Convex:

- `createAuth` sets `rateLimit: { enabled: true, storage: "database" }`. The
  default is `enabled: isProduction` (dead, per `NODE_ENV` above) with in-memory
  storage that Convex's recycled, parallel isolates do not share.
- `convex/otp.ts` (`registerSend`) is the one that actually holds. It runs as a
  Convex mutation, so the read-decide-write is transactional, and it enforces
  both the 60-second resend cooldown and the hourly per-address ceiling from
  `OTP_POLICY`. `sendVerificationOTP` calls it before any mail goes out and
  throws `TOO_MANY_REQUESTS` when it refuses. The decision depends only on send
  history for the address, never on whether an account exists.

### Deletion

Better Auth's `deleteUser` is enabled (Apple requires in-app account deletion).
Its `onDelete` trigger routes through `lib/account-deletion.ts`, which moves the
account to **`deletionScheduled`**, records a `deletionJobs` row due in 30 days
and writes an audit row. Nothing in the codebase sets `deleted` — that belongs
to the P1 purge worker, and reserving it is what keeps the restore window real
(`deleted` is terminal in the account state machine).

### Sentry

`lib/sentry.ts` posts a Sentry envelope over `fetch` rather than initialising
`@sentry/node`, which cannot run in Convex's isolate at all. `beforeSend` is the
same `scrubEvent` from `@partybooth/contracts/scrub` that the browser, the
Next.js server and the Expo app use — one implementation, one set of tests. With
no DSN, and in contexts with no `fetch` (queries and mutations), it falls back to
a scrubbed `console.error`.

**Apple deliberately has no client secret.** PLAN.md makes Sign in with Apple
app-only, and the native id-token flow verifies against Apple's public keys
using the audience — the client-secret JWT is only needed for the web redirect
flow, which we do not ship. So `isAppleConfigured()` checks only
`APPLE_CLIENT_ID` and `APPLE_APP_BUNDLE_IDENTIFIER`, deliberately narrower than
`serverFeatures.appleOAuth` in `@partybooth/env`. `APPLE_TEAM_ID`,
`APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` are unread at launch.

## Guards

```ts
const actor = await requireEventActor(ctx, eventId);
requirePermission(toPermissionActor(actor.user, actor.role), "media.moderate", {
  kind: "media",
  state: media.state,
  isOwn: media.uploaderUserId === actor.user._id,
  event: { state: actor.event.state },
});
```

- `requireUser` / `requireActiveUser` — identity, and the account-state gate.
- `requireGlobalAdmin` — the **allowlist is the authority**, not
  `users.isGlobalAdmin`, which is only a cache for queries.
- `requireEventActor` — resolves the role for an event. A user with no
  relationship gets `notFound`, not `forbidden`, so event ids cannot be
  enumerated.
- `requireEventRole` — seniority within an event. A global admin does **not**
  satisfy it; admin powers never include host powers over someone else's party.
- `requirePermission` — delegates to `@partybooth/contracts`; all the policy
  lives there, this only picks the error.

## Audit

`auditEvents` is append-only and `lib/audit.ts` is the only writer. Actions on
`AUDIT_ACTIONS_REQUIRING_REASON` throw without one rather than writing a row
with a blank reason — a half-recorded lock is worse than a failed one.

## Conventions

- Timestamps are epoch milliseconds, in explicit `createdAt` / `updatedAt`
  columns as well as Convex's `_creationTime`.
- Nothing party-related is hard-deleted at launch; rows move to a terminal state
  and `deletionJobs` records the intent. The purge worker is post-launch (P1).
- Indexes are named `by_<fields>` and exist for every access path the product
  has — `schema.test.ts` asserts them.
- Enum unions come from `@partybooth/contracts` via `lib/validators.ts`, so the
  database and the permission rules cannot disagree.
