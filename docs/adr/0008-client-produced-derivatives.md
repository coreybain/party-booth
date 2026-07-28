# 0008. Client-produced derivatives, ingested as file roles on one capture

- **Status:** Accepted
- **Date:** 1 Aug 2026
- **Sprint:** 4 — moderate, watch, submit (see [`TODO.md`](../../TODO.md))

## Context

Sprint 3 shipped the upload spine and left one line unticked, carried forward by name:

> Preview/poster derivatives; strip location metadata from served derivatives — **open, moved to
> Sprint 4.** … What does not exist is the **server-side** derivative step — nothing writes
> `previewKey`/`posterKey`, so `projectMedia` serves the original to its submitter and to hosts and
> serves nothing to a fellow guest when a row did not claim a strip. `mayServeOriginal` is the seam
> it lands behind; when it does, that branch becomes "serve the derivative" rather than "serve
> nothing".

So the visible symptom was a gallery with holes in it: a guest who had not confirmed a re-encode was
shown _nothing at all_ to other guests, because there was no second artefact to fall back to.
[ADR 0004 §7](0004-private-upload-pipeline.md) is the reason that refusal exists and it is correct;
what it needed was somewhere else to go.

The forces, all fixed before this decision:

- **Convex's isolate cannot host an image pipeline.** `sharp` is native; the isolate is V8 with no
  native modules and no filesystem. This is the same constraint that produced ADR 0004 §7.
- **A server-side derivative writes the GPS-bearing original to storage first.** Even with a
  pipeline, the untouched frame has to land before anything can downscale it, so the window in which
  the sensitive artefact exists is real. ADR 0004 rejected server-side stripping on exactly this.
- **Both clients already produce a preview and throw it away.** `capture.ts` has had two encoding
  profiles since Sprint 3 (2560 px web / 4096 px app for the original, 480/640 px for the preview);
  the preview was local-only "because `media.completeUpload` takes one `fileKey` per capture, so
  there is nowhere to put a second object" (`docs/domain-model.md`).
- **Video needs two derivatives, not one**, and Sprint 4 is the video sprint.
- **The party is on 5 August** and everything has to be verifiable offline.

## Decision

### 1. The client produces the derivatives, and uploads them

There is no server step. The preview and the poster are made on the device, by the same re-encode
that already strips the EXIF block, and sent as separate objects.

This is not the shape anybody would choose with a free hand — the client is not trusted, and asking
it to produce the artefact everybody else is served is asking a lot. It is chosen because the
alternative is worse on the axis that matters most: a server-side step means the GPS-bearing
original is in storage before anything can strip it, and no arrangement of Convex actions changes
that. Trusting a re-encode we can constrain beats storing a frame we cannot.

### 2. One capture, one media row, three objects, distinguished by `fileRole`

`MEDIA_FILE_ROLES` is `original | preview | poster`. A derivative gets **its own grant** under the
**same `captureId`**, with a different role.

Its own grant, because a grant is bound to one exact body — `byteSize`, `checksum`, `mimeType` — and
that binding is the whole reason ADR 0004 works. A grant that covered three files could bind none of
them.

The same `captureId`, because everything that makes the spine safe is keyed on the capture:
`(eventId, captureId)` idempotency, the media row, and `media.withdraw` expiring every unspent grant
for the capture so nothing can attach afterwards. A derivative under a second capture id would be a
second submission, in the moderation queue, in the counters, in the gallery.

The role is carried on the grant, on the upload ticket, and back through `media.confirmUpload`'s
answer — so `checkTicketAgainstGrant` compares it with a **server-minted** value before any bytes
move. Without that, relabelling a 20 MB original as a "preview" at the edge would route it through
the 2 MB cap check and into the wrong column.

Absent means `original`, everywhere, through `fileRoleOf`. Every Sprint-3 row and every client that
has not shipped derivatives keeps working unchanged; there is no migration.

### 3. Derivatives attach; they never settle, count, or create

`registerDerivative` writes one column and stops. It does not move the state, touch
`events.counts`, or write an `uploadCompleted` audit row — it writes `media.derivative_attached`
instead. `settleAfterProcessing` remains driven by the **original** alone.

A capture that arrives as three objects is one submission. Folding derivatives into the completion
action would treble every party's apparent size and make the pending badge count thumbnails.

It also means **a missing derivative never strands a capture**. A phone that dies between the
original and the preview leaves an item that is `pending` and visible to its submitter and the
hosts, exactly as before; what it costs is visibility to fellow guests, not the item. Requiring all
roles before settling would have made a flaky network into a queue full of items nobody can moderate.

Ordering is free. A preview whose original has not landed finds no row and its bytes are **deleted**
rather than orphaned — inventing a media row out of a thumbnail's byte size and checksum is the one
thing the reconciler must not do. The client re-requests a grant, which re-runs every check.

### 4. The metadata claim is _required_ on a derivative, not merely recorded

ADR 0004 §7 records the claim on the original and lets the read path decide, and that works because
an unconfirmed original is served to its submitter and the hosts and to nobody else.

> **Amended in Sprint 4's integration pass.** The claim is two booleans, and the two sides ask for
> different ones. A **derivative grant requires `sourceMetadataStripped`** — "these bytes were
> re-encoded" — because a derivative that is not a re-encode is not a derivative we produced, and
> that is a statement about a process rather than about a file. The **read path reads
> `sourceCarriesNoLocation`**, because the invariant it protects is about location. For a photograph
> the two coincide; for a clip they do not, and forcing one flag to carry both meant the mobile video
> path had to assert a re-encode it had not performed in order to obtain visibility it had honestly
> earned. See `MetadataClaim` in `@partybooth/contracts/media`.

A derivative has no such fallback: it **is** what the gallery and the slideshow hand to everybody
else. So `checkGrantEligibility` refuses a derivative grant that does not claim the re-encode
(`derivativeMetadataNotStripped`) — before the grant exists, rather than storing the object and then
withholding it.

The caps corroborate the claim as far as anything can: a preview is held to **2 MiB** where its
original gets 20, and a 12-megapixel camera JPEG with its EXIF block intact does not fit. That is
not proof — a small image can still carry GPS — and verifying it server-side stays post-launch work,
inherited by the P1 purge worker along with the rest of ADR 0004's revisit list.

### 5. `mayServeOriginal` becomes "serve the derivative", and keeps "serve nothing"

The seam is unchanged in shape. What changed is that there is now something on the other side of it:

- viewer is the submitter or a host → the original, as before;
- the original claims the strip → the original, as before;
- otherwise → the **preview and poster**, and no original;
- otherwise, and no derivative has landed → still nothing.

That last line is not a leftover. It is the invariant: an item whose preview has not arrived shows a
fellow guest no image rather than an unverified original.

### 6. The video caps are enforced twice

`checkGrantEligibility` refuses an over-long video at the grant, judging the client's estimate before
the file exists. `completeUpload` refuses one again on the duration reported for the object that
actually landed, and deletes it.

`byteSize` never needed this — it is bound by `matchesGrant`, one side of which is the value the
server capped — but duration was unbound, so without the second check the 250 MB ceiling was the only
real limit on a video and PLAN.md's "≤ 60 s" was a suggestion.

## Consequences

**Easier later.** The read path has an artefact to serve that is stripped by construction, so the
"serve nothing" branch is now a genuine edge case rather than the common one. The P1 purge worker
gets `previewByteSize`/`posterByteSize` for a storage figure that counts what is actually stored.
Adding a further role — a low-bandwidth variant for a slideshow over a hotspot — is one enum member.

**Harder now.** Three grants per capture instead of one, so the per-account grant ceiling
(60 per five minutes) is now ~20 captures rather than 60. That is still well past any human rate for
a party, but it is a real change and it is the number to raise first if auto-send starts throttling.
The clients also have to produce and upload two or three files per capture, which is the cost the
mobile and web agents are paying this sprint.

**Things to remember.**

- **A derivative grant is not an original grant with a different column.** It names an existing
  capture by id, so it needs an ownership check of its own — without one, any member could attach a
  "preview" to anybody's photo, and the preview is what the whole gallery is served.
- **Absent role means original, and only `fileRoleOf` may say so.** Reading `row.fileRole` directly
  is how a migration-less schema change becomes a preview mistaken for a missing original.
- **Derivatives must never move a counter.** The pending badge is the thing that tells a host whether
  to keep moderating.
- **Withdrawal has to take all three objects.** A withdrawn photo whose preview survived is a
  withdrawn photo the gallery can still render; `storageKeysOf` is the single place that list is
  built.

## Alternatives considered

| Option                                                                  | Why not                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side derivatives in a Convex action                              | The isolate cannot run an image pipeline, and the original — GPS and all — would have to be stored first. Both objections are ADR 0004's, unchanged.                                |
| Derivatives in a separate service (Trigger.dev, a Vercel function)      | New infrastructure, new credential, new failure mode, four days before the party. Trigger.dev is already deferred to P2 for exports.                                                |
| One grant covering all three files                                      | A grant binds one exact body by size and checksum. Covering three would bind none, and the size cap is the one thing a determined client cannot walk around.                        |
| A separate `captureId` per derivative                                   | Every safety property is keyed on the capture. Three ids means three media rows, three queue items, three counted submissions, and a withdrawal that only removes one of them.      |
| A separate `mediaFiles` table                                           | Two columns on `media` express the same thing with no join on a read path that runs per gallery item per approval. Revisit if a capture ever needs an unbounded number of variants. |
| Settle the row only when every derivative has landed                    | A phone that dies between two uploads strands the capture in `processing` for ever, in a product whose entire risk profile is party wifi.                                           |
| Create the media row from whichever grant completes first               | The row would describe the thumbnail: its byte size, its checksum, its mime type. Every downstream check compares against those.                                                    |
| Treat the derivative's metadata claim the way the original's is treated | The original's `false` costs the guest visibility. The derivative's `false` **is** the bypass, because the derivative is what third parties are served.                             |
| Trust that a re-encode drops EXIF and drop the flag on derivatives      | Then nothing distinguishes a genuine preview from the original re-uploaded under a smaller name, and the cap is the only control left.                                              |

## Revisit when

- The P1 purge worker lands: it is the natural place to verify the stripping claim server-side —
  reading the object's first bytes for an EXIF marker — instead of recording it, for derivatives
  first because those are the ones served onward.
- Effects land (**P3**): "never retain pre-effect frames" means the derivative is made from the
  post-effect frame, and the client is the only place that frame exists.
- Anything needs more than three artefacts per capture, or a variant whose bytes the server has to
  produce — at that point the two columns become the `mediaFiles` table this ADR declined to build.
