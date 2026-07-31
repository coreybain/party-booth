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

The `allowLibraryImport` gate is **advisory, and is documented as such**. It is decided on
`mediaSource`, which the client asserts about itself and which defaults to `"capture"` when absent,
and no server-side proof is possible at launch — a phone cannot demonstrate that a JPEG came from
its own camera. It stops a guest tapping "choose from library" at a party where the host asked for
live photos; it is not a security boundary, and the host-facing copy now says so. Making it real
needs a capture attestation rather than a declared source.

The binding is only worth as much as the point at which it is checked, and the route handler in
`apps/web` is the earliest one. `media.confirmUpload` answers the middleware with the grant's own
`mediaType`, `byteSize` and `mimeType`, and `checkTicketAgainstGrant` refuses a ticket that
disagrees **before a presigned URL exists**. Without that the middleware's cap was applied to
attacker-chosen values on both sides — `ticket.byteSize` measured against whichever limit
`ticket.mediaType` selected — so a legitimate 1 MB photo grant authorised a 250 MB "video" upload
into private storage, which Convex then refused and scheduled for deletion. At sixty grants per five
minutes that is about fifteen gigabytes of transient stored bytes and paid egress per guest.

`checksum` is compared in `matchesGrant` at completion, and the upload ticket now carries it through
the middleware metadata so that comparison actually runs. Both sides of it originate on the client,
so it catches an inconsistent client rather than a determined one; **`byteSize` is the binding a
determined client cannot walk around**, because one side of that comparison is the value the server
capped when it issued the grant.

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

The delete is an **action** because a mutation has no network.

An earlier draft of this section said the action should simply not catch, "so it must surface as a
failed action that Convex retries and Sentry sees". That was wrong on both halves and it made the
worst outcome in the product a silent one. **Convex does not automatically retry a failed scheduled
action** — only mutations get that, which is what the action-retrier component exists for — and
nothing in the deployment called `reportError`, so the only trace was a Convex log line. A single
UploadThing 5xx, or a deployment with `UPLOADTHING_TOKEN` unset (where `unconfiguredAdapter`
rejects unconditionally), left a withdrawn guest's photo in private storage indefinitely behind a
row that told them it was gone.

So the retry is **written**: `purgeStoredFile` reports through `reportError` and re-schedules itself
with a bounded backoff (four attempts over about six minutes), then gives up loudly rather than
quietly — an audit row (`media.file_purge_failed`) and a record that still names the objects, so a
retry has something to work from. A bounded loop rather than an unbounded one because a permanent
misconfiguration must not become an endless scheduler job.

The adapter preserves UploadThing's explicit `success` acknowledgement instead of deriving success
from `deletedCount`. An unconfirmed response takes the same retry path as a thrown request. A
confirmed retry can legitimately report zero newly deleted objects because the first call deleted
them and its response was lost; treating that idempotent no-op as failure would retain already-gone
keys forever. Only a provider-confirmed delete stamps `storageDeletedAt` and clears the keys.

And because a stuck purge that nobody can see is a stuck purge that stays stuck,
`media.stuckPurges` lists rows with `deletedAt` set and `storageDeletedAt` unset for the host
console. It returns counts, never keys.

### 7. Location metadata is stripped **client-side, at capture, by re-encoding**

The chosen strategy is that the client re-encodes the frame before it leaves the device — a canvas
or `ImageManipulator` round-trip, which produces a fresh JPEG with no EXIF block and therefore no
GPS, no device serial and no capture timestamp beyond what we ask for explicitly.

Server-side stripping was the obvious alternative and is worse here on every axis that matters this
week. It would mean the untouched original — GPS included — is written to storage first and stripped
afterwards, so the window in which the sensitive artefact exists is real; it needs an image pipeline
in a runtime that has none (Convex's isolate cannot run `sharp`); and it cannot be applied to the
original at all under the "never retain pre-effect frames" rule, only to derivatives.

Because the client cannot be trusted, the claim is **recorded, not assumed**: the media row carries
what the client said it did, and the read path enforces it. `projectMedia` omits `url` entirely for
an item that cannot promise it carries no location, unless the viewer is the submitter or a host.

> **Amended in Sprint 4.** The claim is now two booleans rather than one, because video broke the
> identity between them: `sourceMetadataStripped` ("was re-encoded", required by a derivative grant)
> and `sourceCarriesNoLocation` ("carries no location", read here). Absent means "same as the
> re-encode claim", so everything below still describes the photo path exactly. See `MetadataClaim`
> in `@partybooth/contracts/media` and [ADR 0008](0008-client-produced-derivatives.md). That enforcement is the whole point of recording the flag and it was missing
> for a while: Sprint 3 produces no server-side derivative, so the URL a read path mints **is** the
> uploaded original, and `media.requestUploadGrant` is a public mutation reachable from the browser
> bundle. Without the check, a guest bypassing both first-party pipelines could push a raw camera
> JPEG with a GPS fix and have it served at full resolution to the whole approved gallery, with a
> `false` on the flag costing them nothing.

Hosts keep access because moderating a photo you cannot see is not moderation, and a host is the
party's own data controller rather than a third party. A fellow guest is a third party.

Verifying the claim server-side is post-launch work; the field is what makes that a query rather
than a migration. When the derivative step lands, the check becomes "serve the derivative instead"
rather than "serve nothing".

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
- **A check whose two sides both come from the client is not a check.** Two of the controls here read
  as enforcement and were not, until one side of each comparison came from the server: the
  middleware's size and type cap (now against `confirmUpload`'s answer) and the
  `sourceMetadataStripped` flag (now read on the read path). Anything added to the ticket deserves
  the same question before it is described as a limit.
- **Convex does not retry a failed scheduled action.** Only mutations get automatic retry. Any
  scheduled action whose failure matters has to carry its own bounded backoff and its own alert;
  `purgeStoredFile` is the worked example.
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
