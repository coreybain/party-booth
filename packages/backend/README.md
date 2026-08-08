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
commented where they are. Once Corey runs `bunx convex dev` against a real
project, codegen replaces these files with precise versions and the casts become
no-ops.

Regenerating without a deployment (the CLI insists on _some_ deployment
configuration, but the bundling and codegen steps are local — it only fails at
the final network fetch, after the files are written):

```bash
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY='offline|0000' \
bunx convex codegen --typecheck disable
```

The command **exits non-zero** — it retries the fetch six times and gives up. That is
expected; check `git status` rather than the exit code. Verified during integration: the
files it writes are byte-identical to the committed ones.

Once there is a real project, just `bun run --filter @partybooth/backend dev`.

## Layout

```
convex/
  schema.ts            the tables
  convex.config.ts     registers the Better Auth component
  auth.config.ts       tells Convex to trust Better Auth's JWTs
  auth.ts              component client, user-mirroring triggers, createAuth
  http.ts              mounts Better Auth at /api/auth/*
  users.ts             currentUser, updateProfile, refreshRoles
  otp.ts               registerSend — the transactional OTP send throttle
  events.ts            event CRUD, the state machine, myEvents / activeEvent / home
  invites.ts           rotate, and the current code + QR token (host-only)
  join.ts              the join mutation and the two previews
  media.ts             the upload spine: grants, completion, withdrawal, reads
  moderation.ts        approve / decline / revoke, bulk; reports and the queues
  blocks.ts            per-account blocking (App Review)
  slideshow.ts         the cursored, live, chronological approved feed
  stats.ts             the organiser home: counts, contributors, storage, recents
  demo.ts              seedDemoEvent — the App Review demo party (internal only)
  emails.ts            proving a second address by OTP (Apple private relay)
  testing.helpers.ts   convex-test fixtures and a locally-typed `api`
  lib/
    validators.ts      Convex validators derived from @partybooth/contracts
    guards.ts          requireUser / requireEventActor / requirePermission
    audit.ts           the append-only audit writer
    account_deletion.ts  deletionScheduled + deletionJobs + audit, idempotent
    events.ts          code allocation, invite versions, joinability
    media.ts           media rows: create, reconcile, count, project for a client
    moderation.ts      applyModeration — the one writer of state on that path
    blocks.ts          loading and applying a viewer's blocklist
    upload_grants.ts   minting, finding and atomically spending a grant
    upload_throttle.ts the uploadAttempts rows behind the grant ceiling
    storage/           the provider seam — adapter, fake, UploadThing, resolver
    join_throttle.ts   the joinAttempts rows behind the contract's join policy
    email_matching.ts  verified addresses → organiser / co-host roles
    otp_throttle.ts    the shared per-address OTP send counter
    input.ts           parseInput — contract zod schemas at the mutation edge
    profile.ts         who gets to name a user: choice beats provider default
    hash.ts            SHA-256 hex, via Web Crypto
    errors.ts          ConvexError payloads with machine-readable codes
    config.ts          base URLs, admin allowlist, demo login
    otp.ts             OTP policy → Better Auth options
    providers.ts       Google / Apple, each optional
    sentry.ts          envelope reporter, scrubbed via @partybooth/contracts
    email/             EmailSender interface, Resend + console implementations
```

Files with more than one dot in the name (`*.test.ts`, `auth.config.ts`,
`testing.helpers.ts`) are skipped by the Convex bundler's entry-point scan — it
logs "Skipping … that contains multiple dots" — so tests and their fixtures sit
next to the code without being deployed. The convex-test suites live at the root
of `convex/` because convex-test finds the module map relative to `_generated`,
and Bun's hoisted `node_modules` defeats its automatic discovery;
`testing.helpers.ts` passes `import.meta.glob` explicitly on their behalf.

`testing.helpers.ts` also rebuilds the **typed** `api` from `ApiFromModules`,
the way real codegen would. That is a stand-in for the generic `api.d.ts`
described above and should be deleted the moment `bunx convex dev` has run: until
then it is the difference between tests that check their own argument types and
tests full of hand-written casts.

### `src/client-api.ts` — the clients' view of the same API

The suites can rebuild a precise `api` from the modules; a client bundle cannot,
because it has no access to the handlers. So `src/client-api.ts` declares the
shape of the calls `apps/web` and `apps/mobile` make and casts the generated
object to it **once**, exported as `@partybooth/backend/client-api`.

It is here rather than in each app because both need it and two hand-written
copies of one wire contract drift silently — under `AnyApi` every mismatch is an
`any`, not an error. They had already disagreed about `storageRegion`. Payload
types are assembled from `@partybooth/contracts` wherever a definition exists,
so a contract change breaks this file; only the field lists, which the `v.object`
validators here own, are restated. It collapses to a re-export of
`_generated/api` once codegen is precise, and no call site changes.

### Failure is a value, not an exception, on the counting paths

A Convex mutation that throws **rolls its own writes back**. Any handler that
increments a counter and then rejects the request has to return, not throw, or
the counter never commits and the budget it was protecting is infinite. That is
why `join.join` answers with `{ outcome: "rejected" }` and
`emails.confirmVerification` with `{ ok: false }` instead of raising. It is also
the second reason the join failure path is a value: one code path, one shape,
one timing, nothing for an attacker to distinguish.

### Deployment cost of the Sprint 2 and 3 tables

`joinAttempts`, `userEmails`, `uploadAttempts` and `uploadGrants` accumulate rows
that nothing prunes yet. The first three are small and bounded in practice (one
row per throttle key, one per claimed address). `uploadGrants` is not: it grows
with every capture, and `by_status_and_expiresAt` exists so the P1 purge worker
can sweep the ones nothing ever came back for. It should also collect media rows
with `deletedAt` set but no `storageDeletedAt` — a withdrawal whose file delete
did not land.

## The upload spine

`media.ts` is the whole of it. Four entry points, in the order a photo travels:

| Function                   | Who calls it                 | What it does                                                           |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `media.requestUploadGrant` | guest (app / web)            | permission + size cap + library flag + throttle → a two-minute secret  |
| `media.confirmUpload`      | guest, when its upload ends  | creates the row if the callback has not; asserts nothing about storage |
| `media.completeUpload`     | **`apps/web` route handler** | spends the grant, attaches the file, settles `pending` / `approved`    |
| `media.withdraw`           | the submitter                | tombstone + expire grants + schedule the delete. Permanent.            |

Read paths are `media.myMedia` and `media.eventMedia`; both return short-lived
signed URLs and **never** a file key, and both are permission-checked —
`media.viewOwn` and `media.viewApproved` respectively, which is also what makes a
`locked` or `deletionScheduled` account lose access rather than keep minting
fresh URLs. `media.stuckPurges` is host-only and lists withdrawn rows whose bytes
a purge never removed.

An item that cannot promise it **carries no location** has its **original**
withheld from everyone but its submitter and the hosts — without that check a
client that skipped the re-encode could put a GPS-bearing JPEG in front of the
whole gallery. Since Sprint 4 that is "serve the derivative instead" rather than
"serve nothing", because there is now a derivative to serve.

The claim is two booleans, and `mayServeOriginal` reads the **location** one
(`sourceCarriesNoLocation`), not the re-encode one (`sourceMetadataStripped`).
They are the same fact for a photograph and not for a clip, which no client can
transcode; reading the re-encode flag here would withhold every mobile clip from
every fellow guest on the strength of a flag that answers a different question.
The derivative grant asks the other half, as a precondition. An absent location
claim inherits the re-encode claim, so no row written before the split changed
visibility — see `metadataClaimOf` in `@partybooth/contracts/media`.

### Derivatives (Sprint 4)

The same four functions carry them. A preview or a video poster is a **separate
grant** for the **same `captureId`** with a different `fileRole`, and:

- it is held to its own cap (2 MiB for an image derivative, 25 MiB for a video
  preview clip) rather than the original's;
- its grant is **refused** unless it claims the re-encode
  (`derivativeMetadataNotStripped`) — the original's claim is recorded and read
  on the read path, a derivative's is a precondition, because the derivative is
  what third parties are served;
- `registerDerivative` writes one column and stops: no state change, no counter,
  no `uploadCompleted` audit row. One capture is one submission however many
  objects it is made of;
- a derivative that arrives before its original is **deleted**, not orphaned, and
  a capture with no derivative is never stranded — it settles on the original
  alone.

Video duration is capped twice: at the grant, against the client's estimate, and
at completion, against the duration reported for the object that actually landed.
`byteSize` never needed that — `matchesGrant` binds it — but duration was
unbound, so the 250 MB ceiling was otherwise the only real limit on a video.

Full argument: [ADR 0008](../../docs/adr/0008-client-produced-derivatives.md).

### Moderation, reports and blocks (Sprint 4)

| Function                   | Who            | What                                                            |
| -------------------------- | -------------- | --------------------------------------------------------------- |
| `moderation.moderate`      | owner / cohost | approve · decline · revoke, one item or 200, partial success    |
| `moderation.pending`       | owner / cohost | the queue: flagged first, then oldest first                     |
| `moderation.report`        | any member     | flags an item for a host; does **not** moderate it              |
| `moderation.resolveReport` | owner / cohost | actioned or dismissed; clears the flag when the last one closes |
| `moderation.flagged`       | owner / cohost | reported items with reasons, never with reporter identities     |
| `blocks.block` / `unblock` | any member     | per-account, global, silent, a view filter and nothing more     |
| `slideshow.feed`           | owner / cohost | approved, chronological, resumable from a cursor                |
| `stats.overview`           | host or admin  | counts, contributors, approximate storage — **numbers only**    |
| `stats.recentSubmissions`  | owner / cohost | thumbnails, so an admin cannot reach it                         |

`applyModeration` in `lib/moderation.ts` is the only writer of `media.state` on
that path, and it always does five things at once: the state (through the
machine), the counters, an appended `moderationDecisions` row with the prior
state, the `moderatedAt` stamps, and an audit row. Bulk is the same function per
item, sequentially, because they all patch the same `events.counts`.

Full argument: [ADR 0005](../../docs/adr/0005-moderation-model.md).

Three rules hold across the file, each because breaking it is expensive:

1. **Refusals on the counting paths are values.** A mutation that throws rolls
   its own writes back, so charging a throttle and then raising charges nothing.
   Same reason `join.join` returns `{ outcome: "rejected" }`.
2. **Idempotency is on `(eventId, captureId)`.** The client's confirmation and
   the provider's callback arrive in either order and more than once. Every
   repeat is a no-op that reports success — a callback that returns an error is
   one the provider retries forever.
3. **Single use is the transaction.** `consumeGrant` reads, decides and writes
   inside one mutation. Splitting that, or moving it into an action, silently
   removes the guarantee without changing any policy.

`media.completeUpload` needs **two** credentials: the grant secret says which
upload, `UPLOAD_CALLBACK_SECRET` says the caller is our own route handler.
Without the second, a guest holding their own legitimate grant could name any
file key in the app. An unset secret and a wrong one produce the same refusal.

Full argument, including why metadata stripping happens client-side:
[ADR 0004](../../docs/adr/0004-private-upload-pipeline.md).

### The storage seam

`lib/storage/` is the only code that knows a region is real (ADR 0002). Two
provider operations, because two are all the request path needs — mint a signed
read URL, and delete objects. Grant handling and media records are Convex's
business and deliberately stay outside the interface, so a fake provider cannot
change what a grant means.

| Implementation        | When                                     |
| --------------------- | ---------------------------------------- |
| `uploadthing.ts`      | `UPLOADTHING_TOKEN` is set               |
| `unconfiguredAdapter` | it is not — reads degrade, deletes throw |
| `fake.ts`             | tests, via `useFakeStorage()`            |

The UploadThing SDK is **imported lazily**, from inside the two methods that need
it. That keeps it out of every offline test run and out of any deployment without
a token, and it confines the one thing this repo cannot verify offline — whether
`uploadthing@7` (and its `effect` dependency) evaluates cleanly in a Convex
isolate — to a single file. **The first successful `convex dev` is that
verification.** If it fails, move URL signing to an endpoint in `apps/web` behind
the same `StorageAdapter` interface; no call site changes.

Deletes are scheduled as an **action** because a Convex mutation has no network.
A withdrawal whose bytes are still in storage is the worst outcome the product
has, and **Convex does not retry a failed scheduled action** — only mutations get
that. So `purgeStoredFile` carries its own retry: it reports through
`reportError`, re-schedules with a bounded backoff (four attempts over about six
minutes), and then gives up with an audit row rather than in silence. The record
keeps its keys and its missing `storageDeletedAt` throughout, so
`media.stuckPurges` can list it and a retry has something to name.

The adapter preserves the provider's explicit `success` acknowledgement instead
of inferring success from `deletedCount`. An unconfirmed response takes the same
bounded retry path as a thrown request. A confirmed retry may legitimately
report zero newly deleted objects when the first attempt succeeded and its
response was lost; that is the idempotent success case, so the row is stamped
and its keys are cleared.

## Auth

Better Auth runs **inside Convex**, mounted on the Convex _site_ URL
(`https://<name>.convex.site/api/auth/*`). Its public base URL is resolved per
request: web traffic uses the first-party `SITE_URL` proxy so OAuth cookies stay
on the website, while native traffic uses `CONVEX_SITE_URL` directly.
`BETTER_AUTH_URL` is retained only for a legacy/custom allowed origin; the
`partybooth://` app scheme remains trusted for the native return leg.

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
| `UPLOADTHING_TOKEN`                    | Grants are still issued and media rows still created; read paths return items with **no URL** rather than failing, and a withdrawal's file delete throws (loudly, and retried) instead of silently doing nothing.                    |
| `UPLOAD_CALLBACK_SECRET`               | `media.completeUpload` refuses **every** call, so uploads reach storage and never leave `processing`. Visible and diagnosable — `media.storageStatus` reports it — rather than an open door.                                         |

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
  both the 15-second resend cooldown and the hourly per-address ceiling from
  `OTP_POLICY`. `sendVerificationOTP` calls it before any mail goes out and
  throws `TOO_MANY_REQUESTS` when it refuses. The decision depends only on send
  history for the address, never on whether an account exists.

### Deletion

Better Auth's `deleteUser` is enabled (Apple requires in-app account deletion).
Its `onDelete` trigger routes through `lib/account_deletion.ts`, which moves the
account to **`deletionScheduled`**, records a `deletionJobs` row due in 30 days
and writes an audit row. Nothing in the codebase sets `deleted` — that belongs
to the P1 purge worker, and reserving it is what keeps the restore window real
(`deleted` is terminal in the account state machine).

`users.requestAccountDeletion` is the first-party door to the same function, for
both populations — a guest who signed in with Apple at somebody else's party and
an organiser who runs three of them press the same button. It uses `requireUser`
rather than `requireActiveUser` on purpose: a **locked** account must still be
able to delete itself (`NON_ACTIVE_ACCOUNT_ACTIONS` says so), and refusing here
would leave a suspended user with no way out — which is the complaint App Review
is guarding against. `account.requestDeletion` is what draws the line, and it
refuses an account already scheduled or already purged.

Submissions are **retained and anonymised**, not removed: the photographs belong
to the party as much as to the person who took them, and a host who wakes up to a
gallery with holes in it has been failed. `projectMedia` and `stats` show
"Former guest" from the moment the state changes, so the attribution goes even
though the picture does not — done on the read path rather than by rewriting
`users.displayName`, because the row still has to be recognisable to an admin
resolving an abuse report.

### The App Review demo login

`DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_OTP`, **both or neither**. Set, they make
`emailOtpPolicyOptions().generateOTP` return the fixed code for that one address;
unset, `demoOtpFor` returns `undefined` and there is no path from an environment
variable to a fixed code at all. Nothing anywhere compares a submitted code
against an env var — the code still goes through Better Auth's own verification,
hashed at rest, ten-minute expiry, five attempts — so there is no second way to
be signed in, only a parameter to the first one.

The reviewer's address also skips the per-address send throttle and the email
itself, because there is no mailbox behind it and `sendEmail` refusing is how
"we couldn't email you" surfaces. **No other address is affected in any way.**
Every use writes an `auth.demo_sign_in` audit row; if that action appears in a
deployment real guests are using, that is the incident.

`bun run seed:demo` creates the demo party (`demo.seedDemoEvent`, an internal
mutation, refuses to run unless both variables are set). Pass UploadThing keys to
give the seeded rows thumbnails: `bun run seed:demo key_one key_two key_three`.
**Unset both variables once the build is approved.**

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
