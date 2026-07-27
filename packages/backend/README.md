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
  lib/
    validators.ts      Convex validators derived from @partybooth/contracts
    guards.ts          requireUser / requireEventActor / requirePermission
    audit.ts           the append-only audit writer
    errors.ts          ConvexError payloads with machine-readable codes
    config.ts          base URLs, admin allowlist, demo login
    otp.ts             OTP policy → Better Auth options
    providers.ts       Google / Apple, each optional
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

| Missing                                | Behaviour                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | OTP emails print to the Convex logs, code included. Sign-in works.                                                                          |
| `GOOGLE_CLIENT_ID` / `_SECRET`         | Google provider is not registered. Email OTP still works.                                                                                   |
| `APPLE_CLIENT_ID` / bundle id          | Apple provider is not registered.                                                                                                           |
| `ADMIN_EMAIL_ALLOWLIST`                | Nobody is an admin. A _malformed_ value is ignored with a loud log rather than throwing — a typo must not take down sign-in on party night. |
| `DEMO_LOGIN_*`                         | No reviewer bypass exists.                                                                                                                  |

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
