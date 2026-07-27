# 0002. Per-event `storageRegion`, resolved behind a storage adapter

- **Status:** Accepted
- **Date:** 28 Jul 2026
- **Sprint:** 1 — schema v1 (adapter seam lands with the upload spine in Sprint 3)

## Context

Party photos are unusually personal data, and the people in them are frequently not the people who
uploaded them. "Where do the bytes physically live?" is therefore a question this product will be
asked — by an organiser running an event outside the US, and eventually by a data-protection regime.
It is a question that is cheap to answer at schema-design time and brutally expensive to answer
afterwards, because the answer has to be attached to **every file already stored**.

What is fixed before this decision:

- **Storage is UploadThing**, paid plan, default ACL **Private**, region **`pdx1` (Portland)** —
  confirmed available in the dashboard even though the published region list is stale.
- **Convex is in US East (N. Virginia)**, and a Convex deployment's region is **immutable**. Changing
  it means export/import, not a setting.
- UploadThing's **dynamic region selection is in private beta** — we cannot rely on it for launch.
- The beta is one region and one small party. Multi-region is a real future, not a current need.

So the actual question is narrow: what is the **cheapest thing to build now** that does not make
multi-region a rewrite later?

## Decision

Model the region as data from day one, and hide every consequence of it behind one seam.

1. **`events.storageRegion: string`** exists in schema v1, a string enum whose current membership is
   `["pdx1"]`. It is set at event creation, and becomes **immutable once the first upload lands**.
2. **There is no picker UI.** Events take the single configured default. The field is populated by
   the server, not chosen by a human.
3. **Upload grants carry `storageRegion`**, alongside `eventId`, `captureId`, `mediaType`,
   `byteSize` and checksum. Media rows record the region they were actually written to.
4. **A storage adapter is the only code that knows a region is real.** Given a region value it
   resolves credentials, host and route-handler target. Every read and write path goes through it;
   no call site anywhere else names a region or a provider app.
5. **Files never migrate.** If a region value ever changes, existing objects stay exactly where they
   are — which is why the field locks at first upload.

Convex staying in US East while storage sits in `pdx1` is accepted as part of this: a ~60 ms hop that
touches server-side derivative processing only, never a guest's upload path or a slideshow frame.

## Consequences

**Easier later.** Multi-region becomes a change in two places — the enum's membership, and the
adapter's resolution table — plus a picker UI. No backfill, no migration of stored objects, no
retrofitting a column onto a live media table, no ambiguity about where an old file went.

**Costs now.** A field, a grant property and one indirection, carried for months with exactly one
possible value. Some of this looks like ceremony until the day it does not.

**Things to remember.**

- **The immutability rule needs enforcement, not just documentation.** The mutation that sets
  `storageRegion` must refuse once any media exists for the event. Sprint 3 owns that test.
- **The adapter is only worth having if nothing bypasses it.** The moment one route handler reaches
  for an UploadThing token directly, the seam is decorative. Treat a direct provider import outside
  the adapter as a review failure.
- **`storageRegion` must be recorded on media, not just derived from the event.** They agree today
  and would disagree forever after any future change; the media row is what a deletion or export job
  will have to trust.
- **A cross-region deployment is unusual and worth a comment where it bites.** The next person to
  read a slow processing trace should find the explanation next to the code, not only here.
- **Region does not imply legal compliance.** Storing bytes in Portland is a fact about geography.
  Residency claims would need a great deal more than this field, and the beta makes none.

## Alternatives considered

| Option                                                        | Why not                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No region field; add one when multi-region is actually needed | The retrofit is the expensive part: a nullable column, a backfill guess for every existing file, and no way to know where old objects went. |
| Region per **organiser account** rather than per event        | The unit of data is the event — an organiser can run parties in different countries. Per-event is the smaller, more honest granularity.     |
| Region per **media row only**, no event-level field           | Nothing to validate a grant against, and no way to answer "where does this event live?" before the first upload.                            |
| Ship the picker UI now                                        | One valid value. A picker with one option is a support question, not a feature.                                                             |
| Wait for UploadThing dynamic region selection                 | Private beta, no timeline we control. The adapter makes it a drop-in when it arrives.                                                       |
| Move Convex to US West to sit next to `pdx1`                  | Convex regions are immutable per deployment; the cost is ~60 ms on server-side processing only. Not worth an export/import eight days out.  |
| Self-host storage (S3 + CloudFront) for full region control   | Private ACLs, signed URLs, callbacks and lifecycle rules all become ours to build and get right. Wrong week.                                |

## Revisit when

- A real organiser needs a party stored outside the US — the first genuine trigger.
- UploadThing's dynamic region selection leaves private beta. Fall back to one-app-per-region behind
  the same adapter if it does not.
- Post-launch **P5** in [`PLAN.md`](../../PLAN.md), which is where the picker (auto-suggested from
  locale, editable, locked at first upload) is scheduled.
