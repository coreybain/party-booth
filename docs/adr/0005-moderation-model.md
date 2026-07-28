# 0005. Moderation model: three actions, one mutation, decisions as history

- **Status:** Accepted
- **Date:** 1 Aug 2026
- **Sprint:** 4 — moderate, watch, submit (see [`TODO.md`](../../TODO.md))

## Context

[`PLAN.md`](../../PLAN.md) fixes the shape from outside: launch modes are `manual` and `automatic`
only (`ai` is P1, conservative auto-approve, **never** auto-decline); moderation is "masonry grid,
approve/decline, filters, bulk select"; pending and declined media are visible only to the submitter
and the hosts; and risk #4 is **solo moderation during the party**, mitigated by co-hosts and by
`automatic` as a pressure valve.

Three facts about the room this code runs in:

- **The grid is a live subscription.** By the time a host taps something, another host may have
  dealt with it and the submitter may have withdrawn it. A bulk selection made thirty seconds ago is
  a bulk selection of a stale list.
- **Two hosts on two phones** is the mitigation for risk #4, so concurrent decisions on the same item
  are the design, not an edge case.
- **"Who un-declined this at 1am"** is a question that gets asked, and the `moderationDecisions`
  table has existed since Sprint 1 to answer it.

## Decision

### 1. Three actions, one mutation, `mediaIds` always an array

`MODERATION_ACTIONS` is `approve | decline | revoke`, and `moderation.moderate` takes a list even for
a single item. The grid's single tap and its "select all forty and approve" are the same operation
with a different array length; writing them as two mutations is how the two paths end up disagreeing
about idempotence at 1am. The ceiling is 200 — past that a host is not moderating, they are choosing
`automatic` mode, and an unbounded batch is an unbounded transaction.

### 2. `revoke` is a guard, not a fourth decision

Revoking an approval lands the item in `declined` and writes a `declined` decision row. What makes it
its own action is that it **refuses anything not currently `approved`**.

Without that guard, "un-approve this" silently becomes "decline this thing nobody approved" when two
hosts work the same grid — the second tap does something the person pressing it did not ask for. With
it, the second host gets `notApproved` and the item is untouched.

There is deliberately **no `approved → pending`**. The media state machine does not have that edge
and should not: a host taking a photo off the wall has made a decision, and returning it to the queue
would mean the pending badge — the one number that tells a host whether to keep moderating — counts
items nobody is waiting on.

### 3. Partial success is the contract

Every item in a batch is attempted; refusals come back **itemised** with a reason each; the mutation
throws only for failures of the _request_ (no permission, an event that is not yours, an id from
another party).

Failing the whole batch on the first stale item teaches a host that "approve all" is unreliable, and
they stop using it on the night they most need it. Discarding the refusals silently means they never
learn which ones did not go through. Neither is acceptable, so the answer is both counts and a list.

Idempotence is an **outcome, not an error**: approving something already approved returns
`changed: false` and writes nothing — no second decision row, no second audit line.

### 4. One writer, five effects, one transaction

`applyModeration` is the only thing that moves `media.state` on the moderation path, and it always
does five things together: the state (through the state machine, which refuses illegal moves rather
than writing them), the event counters, an appended `moderationDecisions` row carrying the **prior**
state and the actor, the `moderatedAt`/`moderatedByUserId` stamps, and an audit row.

The bulk path calls it once per item rather than doing its own thing. A "bulk approve" that took a
shortcut through any of the five would be a different feature behind the same button, and the first
time they disagreed would be the night forty photos were approved with no decision rows.

Items are processed **sequentially**. They all patch the same `events.counts` object, and Convex
would turn a parallel batch into a pile of write conflicts against itself.

### 5. "Removed from the gallery immediately" is the state moving

The gallery and the slideshow are reactive queries over `approved`. There is no invalidation step and
no cache to bust: the state moves inside the transaction, the subscriptions re-run, the item is gone.

The one thing that is **not** immediate is a signed URL already handed out, which outlives the
decision by up to ten minutes (ADR 0004: "declining a photo does not invalidate a URL already handed
out; only deleting the object does"). That trade is unchanged here and it is still the right one for
a host who changes their mind at 1am — but revocation is exactly the case where somebody will expect
otherwise, so it is restated rather than left implied.

### 6. A report flags; it does not moderate

Any member may report somebody else's item (`media.report` is in every event role's capabilities,
because a reporting flow only some people can reach is not the one Apple's guideline 1.2 asks for).
The report raises `media.flaggedAt`, which sorts the item to the top of the host's queue, and
**changes nothing else**.

Auto-hiding on report would hand any guest a veto over any other guest's photograph. At a fifty-person
party that is a worse failure than the one it prevents, and the host is in the room.

Reports are idempotent per `(media, reporter)` — pressing the button twice is one person pressing a
button twice, not two complaints, and a count one determined guest can inflate is a count a host
cannot triage by. The count is shown to **hosts only**: telling an uploader they have been reported
turns a report into a confrontation, and telling a bystander is a leak. The reporter's identity is
never returned at all, so a host cannot be asked to take sides.

Resolving the last open report clears the flag; the count survives, because a host deciding an item is
fine does not un-report it.

### 7. A block is a filter on the blocker's own reads

Per-account and **global**, not per-event — someone you have blocked is someone you have blocked, and
a block that evaporated at the next party would not be one. It hides the blocked account's media from
the blocker's gallery and slideshow, notifies nobody, changes nothing for anybody else, and does not
touch a membership. Blocking is not ejecting: a guest cannot remove another guest from a host's party
from their own phone.

In the host's **pending queue** a block sorts last rather than hiding, because otherwise blocking
would be a way for a host to stall their own queue. And a self-block never hides your own media from
you, because a guest who cannot see their submissions cannot withdraw them.

## Consequences

**Easier later.** AI moderation (P1) writes `moderationDecisions` rows with `actor: "ai"` through the
same function and inherits the counters, the audit and the state machine. The admin console (Sprint 5)
reads the same history. `flaggedAt`/`reportCount` are already the queue ordering, so an AI signal
becomes another reason to sort something up.

**Harder now.** Two ways to end up in `declined` — a decline and a revoke — and only the audit
metadata (`moderationAction`) tells them apart, because the decision enum is `approved | declined` by
schema. Anything reporting on "how many did the host take back" reads the audit row, not the decision.

**Things to remember.**

- **The counters are exact because they are written in the same mutation.** A recount in a query
  would eventually disagree with the badge, and the badge is what a host acts on.
- **Every media id in a batch is re-checked against the event.** `mediaIds` is a caller-supplied list
  of document ids; without that check the argument shape alone moderates somebody else's party.
- **A report is not a decision, and a block is not a moderation action.** Both were tempting to
  collapse into the state machine, and both would have given a guest power over another guest's media.

## Alternatives considered

| Option                                              | Why not                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate `approve` / `decline` / `revoke` mutations | Three copies of the same five effects. The first divergence would be silent and would be in the audit trail.                                      |
| Separate single and bulk mutations                  | Same objection, plus the single path is the one that gets the careful treatment and the bulk path is the one used at midnight.                    |
| `revoke` moves the item back to `pending`           | The pending badge would count items nobody is waiting on, and the state machine has no such edge. A host taking a photo down has decided.         |
| All-or-nothing bulk batches                         | One stale item in a live grid fails forty good decisions, and the host stops trusting the button.                                                 |
| Return only counts from a bulk action               | The host never learns _which_ three did not go through, and cannot retry them.                                                                    |
| Treat "already approved" as an error                | Double-tapping is the common case with two hosts on two phones. It must not write a second decision row and must not fail the batch it is in.     |
| Auto-hide reported media pending review             | Hands every guest a veto over every other guest's photograph. The host is in the room; the queue ordering is enough.                              |
| Show reporters' identities to the host              | Turns "is this content acceptable" into "which of my friends complained about which".                                                             |
| Make blocking revoke the blocked guest's membership | A guest would be able to eject another guest from the host's party. Blocking is a view filter; `membership.revoke` is a host power and stays one. |
| Scope blocks to one event                           | A block that stops applying at the next party is not a block, and explaining that to App Review is not a conversation worth having.               |

## Revisit when

- **AI moderation lands (P1):** `MODERATION_ACTORS` gains its third real value, `ai` stops behaving
  as `manual` in `mediaStateAfterProcessing`, and the auto-approve path needs a decision row that is
  clearly not a human's.
- **Anything needs a signed URL to die with a decision** — that is the point at which reads need a
  revocation story rather than a ten-minute expiry, and it is the same trigger ADR 0004 records.
- **Reports outgrow one host:** if a party ever generates enough of them to need triage state beyond
  open/actioned/dismissed, that is a queue, not a flag.
