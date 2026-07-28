# 0004. Private upload pipeline: bound single-use grants, two-sided completion, client-side metadata stripping

- **Status:** Accepted
- **Date:** 31 Jul 2026
- **Sprint:** 3 — the upload spine (see [`TODO.md`](../../TODO.md))

## Context

The upload spine is the highest-risk sprint in [`PLAN.md`](../../PLAN.md), and it is where three
non-negotiable privacy invariants have to become code rather than intent:

> Private ACLs everywhere; permission-checked short-lived URLs; strip location metadata from
> derivatives.

The forces around it, all fixed before this decision:

- **Storage is UploadThing**, paid plan, **default ACL Private**, region `pdx1`, behind the adapter
  from [ADR 0002](0002-storage-region-adapter.md). Route handlers live in `apps/web`.
- **Convex mutations have no network.** A mutation cannot call a provider API at all; only an
  _action_ can. Convex queries cannot either, which constrains where a signed URL may be minted.
- **Convex mutations are serialisable transactions** with optimistic concurrency, and a mutation that
  throws **rolls its own writes back**.
- **The clients are phones on party wifi.** Requests are retried, connections drop mid-upload, and a
  provider webhook and a client's own "I finished" can arrive in either order, more than once each.
- **Guests are not trusted.** A guest is authenticated and a member of the event, and that is all.
- The party is on **5 August** and the whole thing has to be verifiable **offline**, with no
  deployment and no credentials (see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)).

## Decision

### 1. A grant is a bound, hashed, single-use capability

Before any bytes move, a guest calls `media.requestUploadGrant`. It is permission-checked
(`media.upload`), size-capped from `MEDIA_LIMITS` in `@partybooth/contracts`, gated on the event's
`allowLibraryImport` flag, throttled per account, and audited. What comes back is a 32-byte secret
bound to `{eventId, captureId, mediaType, byteSize, checksum, storageRegion}` and valid for **two
minutes**.

The secret is **stored as a SHA-256**, exactly the way `userEmails` stores OTP codes: a leak of
`uploadGrants` must not be a leak of usable capabilities. It is returned once and never logged or
audited.

Consumption is a read-decide-write inside **one mutation**. Convex's serialisable transactions are
what make "single use" true: two racing completions cannot both observe `issued`, because one commits
and the other is re-executed against the committed state. Splitting the check from the write — or
moving it into an action — silently removes that guarantee.

### 2. Refusals on the counting paths are values, not exceptions

`requestUploadGrant` returns `{ outcome: "rejected" | "throttled" }` rather than throwing. A Convex
mutation that throws rolls back its own writes, so a handler that charges a throttle and then raises
has charged nothing and the ceiling it was protecting is infinite. This is the same rule `join.join`
already follows, for the same reason.

### 3. Completion is two-sided, idempotent on `(eventId, captureId)`

Two independent things announce that an upload happened:

- `media.confirmUpload` — the **client**, when its own request resolves. It creates the media row in
  `processing` if nothing has yet, and asserts nothing about what is in storage. Its value is
  latency: a phone can stop showing a spinner without waiting for a server-to-server callback to
  cross the country.
- `media.completeUpload` — the **UploadThing route handler in `apps/web`**, when the provider calls
  back. It spends the grant, attaches the file key, and settles the item into `pending` or `approved`
  per the event's moderation mode.

Both look the row up by `(eventId, captureId)` first and reconcile. Every ordering and every repeat
produces exactly one media row. A concurrent double-insert is prevented by Convex rather than by a
lock: two mutations that both read "no row" conflict, and the loser is re-executed and finds the row.

Everything except an unrecognised grant is reported as **success**, because a completion callback
that returns an error is one the provider retries forever. A duplicate is a no-op; a file that does
not match its grant, a second file against one grant, and a file for a capture that has already been
withdrawn are all **deleted** and audited.

### 4. `completeUpload` needs a second credential

The grant secret says _which_ upload. `UPLOAD_CALLBACK_SECRET` says the caller is our own route
handler. Both are required, and the comparison is constant-time.

Without the second, a guest holding the grant they were legitimately given could name **any** file
key in the app — including one belonging to another party — and have a media row point at it. An
unset secret and a wrong one produce the same refusal, so an unconfigured deployment fails closed
and does not advertise itself.

### 5. Reads are short-lived signed URLs, and never file keys

No read path returns `storageKey`, `previewKey` or `posterKey`. A provider key names an object
directly, so handing one out converts a permission-checked read into a bearer credential that never
expires. Queries return `{ url, expiresAt }` minted by the adapter after the permission check.

The TTL is **ten minutes**, and it is a compromise with Convex reactivity rather than a security
maximum. A Convex query re-runs when its _data_ changes, not when the clock moves, so a URL minted
inside a gallery subscription is as stale as the subscription is old. Ten minutes survives a
slideshow left running; `expiresAt` is returned so a client refreshes rather than serving a broken
image. Signing is done with `UTApi.generateSignedURL`, which the UploadThing docs state does **not**
make a fetch request — which is what makes it legal inside a query at all.

Who sees what is `canSeeMedia` in `@partybooth/contracts/media`, stated as data: guests see
`approved` plus every state of **their own** captures; hosts see everything but `deleted`; global
admins see nothing, because admins never look at guests' photos.

### 6. Withdrawal is permanent, in four places

`media.withdraw` is submitter-only, works from any state, and:

1. moves the row to `deleted`, which is **terminal** in the media state machine;
2. expires every unspent grant for that capture, so an upload in flight cannot complete;
3. schedules an action that deletes the objects and then clears the keys off the record, so nothing
   is left that could mint another signed URL;
4. refuses a fresh grant for the same `captureId` with `captureWithdrawn`.

A late callback that races all of this finds the row `deleted` and deletes its own bytes.

The delete is an **action** because a mutation has no network. It deliberately does not catch: a
withdrawal whose bytes are still in storage is the worst outcome in the product, so it must surface
as a failed action that Convex retries and Sentry sees, never as a log line next to a row that
claims to be deleted.

### 7. Location metadata is stripped **client-side, at capture, by re-encoding**

The chosen strategy is that the client re-encodes the frame before it leaves the device — a canvas
or `ImageManipulator` round-trip, which produces a fresh JPEG with no EXIF block and therefore no
GPS, no device serial and no capture timestamp beyond what we ask for explicitly.

Server-side stripping was the obvious alternative and is worse here on every axis that matters this
week. It would mean the untouched original — GPS included — is written to storage first and stripped
afterwards, so the window in which the sensitive artefact exists is real; it needs an image pipeline
in a runtime that has none (Convex's isolate cannot run `sharp`); and it cannot be applied to the
original at all under the "never retain pre-effect frames" rule, only to derivatives.

Because the client cannot be trusted, the claim is **recorded, not assumed**:
`media.sourceMetadataStripped` carries what the client said it did. An item without it is never
served as a derivative to anyone but its submitter and the hosts. Verifying it server-side is
post-launch work; the field is what makes that a query rather than a migration.

## Consequences

**Easier later.** Video needed no new pipeline — `MEDIA_LIMITS` already knows what a video may weigh
and how long it may run, so Sprint 4 adds a camera screen and nothing else. The P1 purge worker has
the two things it needs: `uploadGrants.by_status_and_expiresAt` for grants nothing ever came back
for, and media rows with `deletedAt` set but no `storageDeletedAt`.

**Harder now.** Two secrets instead of one, set in two dashboards, either of which being wrong
produces uploads that reach storage and never leave `processing`. `media.storageStatus` exists so
that is diagnosable from the host console rather than from a log.

**Things to remember.**

- **The single-use guarantee is the transaction, not the status column.** Any refactor that moves the
  check and the write apart, or into an action, removes it without changing a line of the policy.
- **`UPLOAD_CALLBACK_SECRET` is a real credential.** It is what stands between a guest and pointing a
  media row at somebody else's file.
- **Ten minutes of signed URL outlives a moderation decision.** Declining a photo does not invalidate
  a URL already handed out; only deleting the object does. Withdrawal deletes; declining does not.
  That is the correct trade for a host who changes their mind at 1am, and it is a trade.
- **The UploadThing SDK is imported lazily and has never run in a Convex isolate.** `effect` and
  `@effect/platform` are runtime-agnostic and there is no reason to expect trouble, but nothing here
  can prove it offline. The first successful `convex dev` is the verification; if it fails, the
  fallback is a signing endpoint in `apps/web` behind the same `StorageAdapter` interface, and no
  call site changes.

## Alternatives considered

| Option                                                       | Why not                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client uploads straight to UploadThing with a shared app key | The key is the whole app. Nothing binds an upload to an event, a size or a person, and rotating it means shipping a new client build mid-party.                            |
| Grant as a signed JWT instead of a database row              | A stateless token cannot be single-use, and single use is the property this exists to have. It also could not be revoked when a capture is withdrawn.                      |
| One-sided completion (provider callback only)                | The phone's spinner then waits on a US-East↔`pdx1` round trip it has no visibility into. The client half is what makes the UI honest about what it knows.                  |
| One-sided completion (client only)                           | The client is not a source of truth about what is in storage. A guest could claim any file key.                                                                            |
| Store the grant secret in plaintext                          | A leak of the table becomes a leak of live capabilities, for no gain — the lookup is by hash through an index either way.                                                  |
| Return file keys and let clients fetch                       | A private ACL means the key alone does not work today — and the day someone flips an ACL, every key ever handed out becomes a public URL.                                  |
| Mint signed URLs in an action instead of a query             | Every gallery item becomes a second round trip, and the reactive query — the thing that makes the slideshow live — can no longer carry what it needs to render.            |
| Server-side EXIF stripping                                   | Writes the GPS-bearing original to storage first, needs an image pipeline Convex's isolate cannot host, and cannot touch the original under the no-pre-effect-frames rule. |
| Trust the client's stripping claim and drop the column       | Makes an unverifiable assertion invisible. Recording it costs one boolean and turns future verification into a query.                                                      |
| Delete files synchronously in the withdrawal mutation        | Not possible — a Convex mutation has no network. Scheduling is not a workaround, it is the only shape available.                                                           |

## Revisit when

- The 30-day purge worker lands (**P1**): it inherits the two sweeps described above, and it is the
  natural place to verify the metadata-stripping claim server-side instead of recording it.
- AI moderation lands (**P1**): `mediaStateAfterProcessing` gains a third answer, and the ten-minute
  read TTL should be re-examined against auto-approve latency.
- Anything wants a signed URL to outlive a moderation decision — that is the point at which reads
  need a revocation story rather than an expiry.
