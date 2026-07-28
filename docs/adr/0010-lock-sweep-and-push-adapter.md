# 0010. Derive the lock freeze from the event's owner, and put Expo push behind an adapter

- **Status:** Accepted
- **Date:** 2 Aug 2026
- **Sprint:** 5 (see [`TODO.md`](../../TODO.md))

## Context

Sprint 5 is co-hosts, rotation, push and the admin console, and three of its four lines turned out
to rest on the same two structural questions.

**How far does a lock reach?** PLAN.md and TODO.md both say a lock "suspends owner/co-host access,
joins, uploads and slideshows **across owned events**", and RC5 is a demonstration of exactly that:
"lock the organiser from `/admin` and watch everything freeze". What the codebase actually enforced
was the _actor's_ own account state — `requireActiveUser`, `accountStateAllows`, and a handful of
explicit `accountState !== "active"` checks in `media`, `moderation` and `join`. Every one of those
asks about the caller. None of them asks about the party. So locking a host left their co-host
moderating, their guests uploading, the slideshow running and new guests walking in off a printed
QR — the control existed and did approximately nothing.

**Where does the Expo HTTP call live?** CI has no secrets and everything in the repository has to
typecheck and unit-test fully offline. Push is the first feature whose entire value is a third-party
network call, and the parts most likely to be wrong — chunking at 100, receipt checking, deciding
which error kills a token — are exactly the parts you cannot exercise without a real dead phone.

## Decision

**The freeze is a property of the event, computed from its owner, and asserted in one place.**
`lib/lock.ts` maps an owner's `accountState` onto a verdict for the whole event, and
`requireEventActor` — the single function every event-scoped read and write in the product passes
through — asserts it after resolving the role. `join.ts` asserts it separately, because joining is
the one path that reaches an event without a membership. A `globalAdmin` passes through, so the
console can inspect what it just froze.

**Expo push goes behind `PushAdapter`** (`lib/push/`), with a real `fetch` implementation, a fake,
and an unconfigured no-op, resolved through one function with a `globalThis` test seam — the same
shape and the same argument as the storage adapter in [ADR 0002](0002-storage-region-adapter.md).
The decision to notify is a database write (`pushNotifications`, `notificationThrottles`), because a
Convex mutation has no `fetch`; the send is an action that drains the queue.

## Consequences

- **The sweep is total by construction.** There is no event — existing, or created a second before
  the lock — that an enumeration could miss, and no surface added in Sprint 6 that has to remember
  to check. That is the whole reason it is not "lock the account, then loop over their events".
- **Every event-scoped request now costs one extra `ctx.db.get`** when the actor is not the owner.
  Acceptable at this scale and worth measuring if a party ever gets large; the owner's own reads pay
  nothing, because the guard is handed the document it already has.
- **`requireEventActor` now throws `forbidden` for a case that used to succeed.** Any future handler
  that wants to work on a frozen event — an admin tool, a purge worker — has to reach the row
  directly rather than through the actor guard. `admin.ts` does exactly that.
- **The freeze message is deliberately vague.** "This event is suspended" and nothing about whose
  account or why: the alternative broadcasts a third party's standing with us to thirty people at a
  door.
- **The whole notification stack is unit-testable with no network and no credentials** — chunk
  sizes, receipt handling, token pruning and the debounce all have real tests. The cost is that the
  real adapter's HTTP shape is verified only by reading the docs, so
  `EXPO_PUSH_SEND_ENDPOINT` and its neighbours are asserted against transcribed constants and a
  change to them is a deliberate edit.
- **A deployment with no `EAS_PROJECT_ID` silently sends nothing**, marking rows `dropped`. That is
  the right failure — a party where nobody's phone buzzes is a party — but it means "push is not
  working" and "push is not configured" look identical from a phone. `push.status` exists for hosts
  and `admin.jobHealth` for the console so the question is answerable.
- **`envHas` had to be fixed to make the gate real.** It returned `.ok`, and an _optional_ schema
  parses an absent value successfully — so every feature flag reading an optional variable was
  permanently on, `serverFeatures.sentry` and `expoPush` included. It now asks about the value.

## Alternatives considered

| Option                                                 | Why not                                                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sweep owned events at lock time (write a flag on each) | Misses anything created afterwards, needs an unbounded write inside the lock mutation, and leaves two sources of truth that can disagree after a restore.             |
| Cascade the lock into `events.state`                   | Destroys the state the host was in. Unlocking would have to guess whether the party was `live` or `paused`, and an event's own state machine is the host's, not ours. |
| Check the freeze in each handler                       | Fifteen checks, fifteen chances to miss one, and the sixteenth surface has none. This is the failure the sprint started from.                                         |
| `expo-server-sdk` instead of an adapter over `fetch`   | The Convex runtime is a V8 isolate, not Node; the SDK's value is chunking and retries, which are twelve lines we own and can test offline. Same trade as Resend.      |
| Send inline from the mutation                          | Impossible — a Convex mutation has no `fetch`. This is not a preference.                                                                                              |
| Fire the action directly with the message, no queue    | A crash, a redeploy or a transport failure between the decision and the send loses the notification with no record that it was ever owed.                             |
| Prune tokens on any Expo error                         | `InvalidCredentials` is the _project's_ APNs key. Pruning on it empties the device table the day somebody rotates a certificate.                                      |

## Revisit when

- A party grows past a few hundred members and the per-request owner lookup shows up in a trace —
  the fix is to denormalise the freeze onto `events` and maintain it in the lock mutation, with the
  derivation kept as the reconciler.
- Expo's push API changes shape, or the 600/second project ceiling starts to bind (it will not at
  10–50 guests). Re-read the docs and re-check the constants in `@partybooth/contracts/push`.
- A second notification transport appears (web push, email digests), at which point `PushAdapter`
  stops being Expo-shaped and the ticket/receipt concepts need a home that is not the interface.
