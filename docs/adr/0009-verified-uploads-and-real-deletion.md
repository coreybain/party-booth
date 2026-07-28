# 0009. Verified uploads, reconciled reads, and deletion that deletes

- **Status:** Accepted
- **Date:** 1 Aug 2026
- **Sprint:** 4 — moderate, watch, submit (see [`TODO.md`](../../TODO.md))
- **Amends:** [ADR 0008](0008-client-produced-derivatives.md) §4 and §6; supersedes its video
  `preview` role and its "verify the stripping claim post-launch" deferral.

## Context

Sprint 4's audit found the same shape of defect in six places, and it is worth naming the shape
rather than the six: **a control that reads a value the controlled party supplied.**

- The 60-second video cap was "enforced twice". Both enforcement points read the client's own
  `durationSeconds` — the completion callback forwards `metadata.durationSeconds`, which
  `apps/web`'s route handler copies verbatim off the client-authored upload ticket. Convex was
  re-reading the same claim, not checking it. A modified client could declare eight seconds and
  store a ten-minute recording under the 250 MB ceiling.
- A derivative's re-encode claim was required at grant time and read by nothing afterwards.
  `projectMedia` minted `previewUrl` for every viewer with no read-time check at all, and nothing
  compared a derivative's bytes with the original's — so the derivative slot was the way around
  `mayServeOriginal`. Upload the withheld GPS-bearing original a second time under
  `fileRole: "preview"` and the whole gallery is served it.
- A retry against an existing `processing` row was checked for ownership and state and not for
  **what file it was**, so a second grant could attach video bytes to a row recording a photograph.
- The slideshow's cursor ran on capture time and its client playlist was append-only, so an item
  approved out of order never arrived and an item a host revoked never left — for the full
  ten-minute life of a signed URL that decline does not revoke.
- The App Review demo credential was published, live against production, and confined by nothing
  but the absence of an invitation.
- "Delete my account" scheduled a job that no worker ever ran.

Two store-policy gaps sat alongside them: no terms of use and no acceptance anywhere in the
repository, and a Play-declared web deletion URL with no route behind it.

## Decision

### 1. Every claim gets a check with a server value on the other side of it, or it is not a check

**Video duration is measured.** `media.verifyVideoDuration` is scheduled when a video original
settles; it fetches the object's own first bytes and reads the duration out of the container
(`readIsoBmffDuration` in `@partybooth/contracts/video`). A Convex isolate cannot decode video, but
it does not need to: an ISO base-media file states its duration in twenty bytes of `mvhd`, which is
arithmetic on a `Uint8Array` and therefore pure and testable offline. Over the cap → the object is
deleted and the row tombstoned. Under it → the measured figure replaces the client's on the row.
**Unparseable → the file is kept** and `durationVerified: false` records that the check did not run;
deleting a guest's real fifty-five-second clip because a parser did not recognise WebM is a worse
failure at a party than the one this prevents.

**A derivative must not be its own source.** A decode/re-encode round trip never reproduces its
input byte for byte, so a derivative whose checksum equals the original's _is_ the original,
re-labelled. Refused at grant and again at completion. This is the cheap server-side corroboration
ADR 0008 §4 deferred, and it needs no image pipeline.

**A derivative's location claim is read at read time.** `mayServeDerivative` asks of a derivative
exactly what `mayServeOriginal` asks of an original, so the seam is symmetrical instead of open on
one side.

**A capture's file facts are immutable.** `describesSameFile` compares a retry's grant against the
row that already exists, at grant time and again at completion. A retry re-sends the same body —
both clients do — and anything else is a different capture and needs a different `captureId`.

### 2. The video `preview` role is withdrawn, not left open

ADR 0008 gave a video a `poster` and a `preview`, and the `preview` was never produced by either
client — nothing in Expo or a browser transcodes video. What it _was_ is a 25 MiB slot accepting the
original's own containers, against which the distinctness check above is the only corroboration
worth anything. Closing it is the honest state while the artefact does not exist; it returns with a
transcoder and a container check, in P2.

`DERIVATIVE_LIMITS.videoPreview` goes with it. Every derivative is now an image.

### 3. The slideshow reconciles rather than accumulates

The cursor runs on `media.approvedAt` — stamped by the two things that can approve — so an item
approved out of capture order reaches the television at once. The feed returns `approvedIds`
alongside the page, computed from the same scan that already produced `total`, and the client
prunes anything absent from it. A host taking a reported photograph off the wall is the remedy
`resolveReport` exists to provide, and it now works within a slide rather than within ten minutes.

`approvedIdsComplete` guards the prune: a party past the cap sends a truncated list, and pruning
against a truncated list would delete the show.

### 4. The reviewer identity is confined, and expires

Three variables instead of two, the third being `DEMO_LOGIN_EXPIRES_AT`, mandatory and failing
closed — the bypass switches itself off on a date rather than when somebody remembers. And
`assertDemoConfinement` refuses the demo identity every event that is not `events.isDemo`, at join
and before any role is resolved. "It unlocks a party with no real people in it" was true only for as
long as nobody handed it a code, which is an absence rather than a control.

The seeded reviewer row is adopted by the first real sign-in (`seeded: true` + normalised email),
rather than shadowed by a second row under the provider's id.

### 5. Deletion deletes

`convex/deletion.ts`, run daily by `convex/crons.ts`, erases a due account: media tombstoned and
objects purged, memberships, blocks, push devices and verified addresses removed, Better Auth user
deleted (which takes the sessions and the Apple and Google grants), mirror row anonymised and moved
to `deleted`, job closed, audit row written.

This reverses PLAN.md's "submissions are retained and anonymised". Retention is a defensible answer
for the thirty days a restore is possible and is not a defensible answer to "delete my data". A
party the person **hosted** is archived rather than erased — their guests' photographs are not
theirs to delete.

### 6. Terms exist, and are accepted before content

`/terms` publishes the rules; `@partybooth/contracts/terms` holds the version and the prohibited
categories so the page, both onboarding screens and the report sheet cannot drift. Onboarding sends
`TERMS_VERSION` with the name confirmation; an account without the current version is refused an
upload grant (`termsNotAccepted`). `/account/deletion` is the web deletion route Play requires, with
the sign-in as its identity verification.

## Consequences

**Easier later.** The duration parser is the shape every future content check has: a pure function
over bytes, plus a scheduled action that fetches a range. The P1 purge worker's EXIF verification
lands the same way, and now has somewhere to land.

**Harder now.** A video costs one extra storage read after it settles. The slideshow feed carries an
id list per page. A capture that a client genuinely re-encodes differently on retry is refused —
correct, and a behaviour change for any client that does not retry from its stored draft. Neither of
ours does.

**Things to remember.**

- **`unverifiable` is not `withinCap`.** Three verdicts, three actions, and collapsing the third
  into either of the others is how this check starts deleting real footage or stops meaning
  anything.
- **Prune only when the id list is complete.** `approvedIdsComplete` is the whole safety of the
  reconcile.
- **Adoption is confined to `seeded` rows.** Matching on address alone would let whoever next signs
  up with an address claim an existing account.
- **The purge worker archives owned events; it never cascades into them.**

## Alternatives considered

| Option                                                           | Why not                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust the client's duration and cap the byte size harder         | Size does not bound duration. A ten-minute recording fits in 20 MB; a 60-second one can be 200 MB.                                                                |
| Probe the duration before settling the row                       | Every guest waits on a storage round trip before their photo appears. The exposure window is seconds; a real measurement afterwards beats an earlier guess.       |
| Keep the video `preview` slot and add a container/duration check | The check would compare the derivative against the same unverified claim. Closing an unbuilt feature costs nothing.                                               |
| Have the client send `removedIds` diffs for the slideshow        | The client cannot know what it has not been told. The authoritative set is one array off a scan already being done.                                               |
| Block the demo login in production by environment                | ADR-adjacent and already rejected in `lib/config.ts`: App Review reviews the production build against the production backend. Confinement is the axis that works. |
| Keep retaining a deleted account's media                         | Defensible for thirty days, not as an answer to a deletion request. Both stores ask about _associated data_.                                                      |
| Cascade a deleted host's events into their guests' media         | Destroys data belonging to people who asked for nothing.                                                                                                          |
| A terms checkbox separate from onboarding                        | One more screen between a guest and a party, for an acceptance the onboarding button can carry honestly.                                                          |

## Revisit when

- A transcoder exists (P2/P3): the video `preview` role returns, with a container and duration that
  must differ from the original's.
- The P1 purge worker's EXIF verification lands: it is the same shape as the duration probe and
  should share its fetch-a-range seam.
- A party outgrows `MAX_APPROVED_IDS`: the slideshow needs a real delta protocol rather than a set.
