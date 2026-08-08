# Glossary

One agreed word per concept, so the code, the docs and the conversation match. Alphabetical.

If you need a new term, add it here in the same PR that introduces it. If you catch two words for
one thing, delete one.

---

**Approved** — the media state in which an item is visible in the event gallery and eligible for the
slideshow. Reached from `pending` by a host, or directly from `processing` when the event's
moderation mode is `automatic`.

**Audit event** — an immutable record of a privileged action: actor, action, subject, reason,
timestamp. Every admin and host action writes one. Never edited, never deleted.

**Automatic (moderation mode)** — media is approved on arrival, with no review queue. The pressure
valve when the host cannot keep up on party night.

**Better Auth** — the identity library, running on Convex. Owns sessions, the email-OTP provider and
the Google/Apple OAuth providers.

**Capture** — a single act of taking a photo or video on a device, before it becomes server-side
media. Carries a client-generated `captureId` that survives retries, which is what makes upload
idempotent.

**Co-host** (`cohost`) — a member invited by the owner to help run an event. Moderates, rotates
invites, sees the host surfaces. **Never** deletes or transfers the event.

**Contracts** — `packages/contracts`: the shared zod schemas, permission rules and role types used by
both `apps/*` and `packages/backend`. The authority on validation and on who may do what.

**Declined** — the media state set by a host rejecting a submission. Not visible in the gallery.
Reversible: a host may approve later.

**Deletion scheduled** (`deletionScheduled`) — an account or event queued for deletion. Access is
revoked **immediately**; it is not a warning state. The hard purge is post-launch.

**Derivative** — any processed version of an original: preview image, video poster, thumbnail.
Location metadata is stripped from every served derivative — and since Sprint 4 a derivative's grant
is **refused** unless the client claims the re-encode, because the derivative is the artefact
everybody except the submitter and the hosts is actually served. See
[ADR 0008](adr/0008-client-produced-derivatives.md).

**File role** — which artefact of a capture a stored object is: `original`, `preview` or `poster`.
One capture is one media row and one `captureId`, but up to three objects, each with its own bound
single-use grant. Absent means `original`, which is what every pre-Sprint-4 row means.

**Flagged** — a media item with at least one open report on it. It sorts to the top of the host's
queue and is nothing else: a report is a complaint, not a moderation decision.

**Block** — one guest choosing not to see another. Per-account, global, silent, and a filter on the
blocker's own reads only. It is not ejecting: it changes nothing for anybody else and does not touch
a membership.

**Revoke (an approval)** — taking an approved item back off the wall. It lands in `declined` like a
decline, but refuses anything not currently approved, so it cannot silently become "decline this
thing nobody approved" when two hosts work the same grid.

**Dress rehearsal** — the ~3 Aug run-through with about five real people and real phones. The last
point at which a finding can still change the build.

**EAS** — Expo Application Services: the hosted build and submit pipeline for `apps/mobile`.

**Event** — one party. Owns a schedule and timezone, a moderation mode, an invite version, a
`storageRegion`, its memberships and all its media.

**Global admin** (`globalAdmin`) — a platform operator, working in the separate `/admin` shell.
Manages accounts, events and codes. Has **no media access and no impersonation**.

**Grant** — a short-lived, single-use upload authorisation issued by Convex, carrying `eventId`,
`captureId`, `mediaType`, `byteSize`, checksum and `storageRegion`. Route-handler middleware
validates it before any upload URL is issued. Expiry and single use are unit-tested.

**Guest** (`guest`) — someone who joined an event to contribute. Captures, uploads, sees their own
submissions and status, withdraws, views the approved gallery.

**Internal testing** — the Play Console track that publishes instantly to a fixed tester list. The
Android distribution route for the party, because production access is gated behind a 14-day
closed-testing rule on a new account.

**Invite version** — one generation of an event's join credentials: a six-digit **join code** plus a
high-entropy **QR token**. Exactly one is active at a time. Rotation mints a new one rather than
mutating the old.

**Join code** — the six-digit number a guest can type instead of scanning. Unique among joinable
events. Enumeration-protected, because a million values is not many.

**Locked** — an account state set by a global admin. Suspends owner and co-host access, joins,
uploads and slideshows across every event that account owns. The party-night emergency stop.

**Manual (moderation mode)** — every submission lands in `pending` and waits for a host. The default.

**Media** — a submitted capture as the server knows it: the original bytes plus derivatives, a
moderation state, a submitter, an event and a `storageRegion`.

**Membership** — a user's presence in one event, carrying their role and the invite version they were
admitted under. The same person can be an owner in one event and a guest in another.

**Moderation mode** — per event: `manual` or `automatic` at launch, `ai` post-launch.

**Organiser** — everyday word for the person running an event. In code this is the event `owner`
role; "organiser" also names the website they use, as opposed to the `/admin` console.

**Original** — the final submitted capture, including any applied effects. Pre-effect frames are
never retained. Moot at launch, since the camera is clean.

**OTP** — the six-digit one-time code emailed for sign-in. Ten-minute expiry, five attempts,
15-second resend cooldown. Delivered by Resend.

**Owner** (`owner`) — the creator of an event, with full power over it including deletion and
transfer.

**pdx1** — the UploadThing region in Portland, Oregon. The only value of `storageRegion` in the beta.
Confirmed available in the dashboard; the public docs region list is stale.

**Pending** — the media state awaiting host review. The count on the organiser home.

**Processing** — the media state between an upload starting and a moderation outcome. Transitions in
and out of it must be idempotent, because the client's confirmation and the provider's callback
arrive in either order and more than once. A `processing` row with no storage key is an upload that
never finished.

**Purge** — the irreversible destruction of data after the deletion window. Automated post-launch
(P1); operated by script until then.

**QR token** — the high-entropy value embedded in the universal link behind an event's QR code.
Rotated together with the join code as part of an invite version.

**RC (releasable checkpoint)** — the end-of-sprint state in `TODO.md` (RC1–RC7) that can be opened on
a real phone that evening. A sprint is not done until its RC is verified.

**Rotation** — replacing an event's invite version with a fresh code and QR token, with a keep-or-
revoke choice for existing memberships. Old versions are rejected at join.

**Slideshow** — the fullscreen, live-updating projection of approved media. Photos and muted
autoplay video, pause and skip, chronological or shuffled.

**`storageRegion`** — the per-event field naming where that event's bytes live. Set at creation,
immutable once the first upload lands, carried on grants and media. See
[ADR 0002](adr/0002-storage-region-adapter.md).

**Storage adapter** — the seam that turns a `storageRegion` value into credentials and a host. The
only place in the codebase that knows a region is a real thing. Its two provider operations are
"mint a short-lived signed read URL" and "delete these objects"; grant handling and media records are
Convex's business, not the provider's.

**Universal link** — the HTTPS URL a QR code resolves to. Opens the app when installed, otherwise
falls through to the mobile web join page. Never a custom scheme, which is why the domain matters.

**UploadThing** — the private-storage provider. Paid plan, region `pdx1`, default ACL **Private**.

**Upload grant** — short-lived (two minutes), single-use permission to put one exact file into
storage, bound to `{eventId, captureId, mediaType, byteSize, checksum, storageRegion}`. A guest holds
one of these instead of a provider credential. Stored hashed; spent atomically. See
[ADR 0004](adr/0004-private-upload-pipeline.md).

**Upload ticket** — what a client POSTs to `/api/uploadthing` alongside the bytes: the grant secret
plus its claims about the file (`captureId`, `mediaType`, `byteSize`, `mimeType`, `checksum`,
dimensions). Only the secret carries authority; the rest is cross-checked against the file actually
offered before a presigned URL is minted, and against the grant inside Convex afterwards. Defined
once, in `@partybooth/contracts/upload`, because both clients build one and neither imports the
other. Not a synonym for "grant" — a grant is a capability, a ticket is an envelope carrying one.

**Capture id** — a client-generated, unguessable id minted the moment a photo is taken and **reused
for every retry of it**. Media rows are keyed on `(eventId, captureId)`, so a retry after a dropped
connection lands on the row already there instead of creating a second copy in the host's queue. It
encodes nothing; the leading `w`/`m` says which client minted it and nothing may branch on it.

**Storage adapter** — the seam every read and delete in `convex/` goes through, resolved from the
region on the row (`resolveStorageAdapter`). It is the only caller of the UploadThing SDK in the
deployment, which is what lets the whole repo be tested with an in-memory fake and no credentials.
See [ADR 0002](adr/0002-storage-region-adapter.md).

**Upload callback secret** (`UPLOAD_CALLBACK_SECRET`) — the shared secret proving a completion call
came from our own UploadThing route handler rather than from a guest replaying the grant they were
legitimately given. Required _in addition to_ the grant.

**Withdrawn** — a submitter taking their own item back. Permanent: the record moves to the terminal
`deleted` state, the bytes are deleted from storage, any unspent grant for the capture is expired,
and the same `captureId` can never be uploaded again. `withdrawnAt` is what distinguishes it from a
host removal.

**Category** (push) — the unit of notification opt-out: `uploadStatus`, `eventLifecycle`,
`hostPendingThreshold`. Stored as an **opt-out list** rather than a map of booleans, so a new
category defaults to _on_ for every account that has never seen the toggle.

**Freeze** — what a locked (or deletion-scheduled) **owner's** account does to every event they own:
suspended for everybody, not just for them. Co-host access, joining, upload grants, the slideshow
and signed-URL issuance all stop. Derived from the event's owner at read time rather than swept over
a list of events, so nothing can be missed. Distinct from **pause**, which is a host's own choice
and leaves the gallery readable.

**Push receipt** — Expo's second answer, read about fifteen minutes after the send. The _ticket_
says Expo accepted the message; the receipt says whether Apple or Google took it, and it is where
`DeviceNotRegistered` almost always arrives — which is why the receipt sweep, not the send, is what
prunes dead tokens.

**Reason** (admin) — the non-empty string every `/admin` mutation carries into its audit row. Refused
at the schema on the way in and refused again by the audit writer, so a mutation cannot skip it by
not being called from the console.

**Sweep** (rotation) — a rotation with `keepExistingMemberships: false`, which revokes every guest
membership. Deliberately distinguished in the row (`revokedByRotation`) from a host's **removal** of
one person: a removal survives a fresh scan of a valid QR, because it is a judgement about that
person; a sweep does not, because it is a judgement about the credential and everybody coming back
is holding the replacement.

---

## Words we deliberately do not use

| Avoid                     | Say instead                | Why                                                                |
| ------------------------- | -------------------------- | ------------------------------------------------------------------ |
| "photo" for anything sent | **media**, or **capture**  | videos exist from Sprint 4 and the distinction matters             |
| "admin" for an organiser  | **organiser** / **owner**  | `globalAdmin` is a different, much stronger role                   |
| "delete" for a guest act  | **withdraw**               | deletion is an account/event lifecycle word with a purge behind it |
| "reject"                  | **decline**                | one verb, matching the media state                                 |
| "invite link"             | **invite version**         | the credentials rotate as a unit — code and token together         |
| "public URL"              | **short-lived signed URL** | there are no public media URLs anywhere in this product            |
| "file key" in a payload   | **short-lived signed URL** | a key names an object directly; it must never reach a client       |
