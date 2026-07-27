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
Location metadata is stripped from every served derivative.

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
60-second resend cooldown. Delivered by Resend.

**Owner** (`owner`) — the creator of an event, with full power over it including deletion and
transfer.

**pdx1** — the UploadThing region in Portland, Oregon. The only value of `storageRegion` in the beta.
Confirmed available in the dashboard; the public docs region list is stale.

**Pending** — the media state awaiting host review. The count on the organiser home.

**Processing** — the media state between a completed upload and a moderation outcome, while
derivatives are generated. Transitions in and out of it must be idempotent, because completion
callbacks can arrive out of order.

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
only place in the codebase that knows a region is a real thing.

**Universal link** — the HTTPS URL a QR code resolves to. Opens the app when installed, otherwise
falls through to the mobile web join page. Never a custom scheme, which is why the domain matters.

**UploadThing** — the private-storage provider. Paid plan, region `pdx1`, default ACL **Private**.

**Withdrawn** — the terminal media state a submitter sets on their own item. It disappears from every
surface.

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
