# `@partybooth/contracts`

The shared vocabulary: roles, states, limits, permission rules, join codes, OTP
policy and analytics names. Imported by `apps/web`, `apps/mobile` and
`packages/backend`, so a rule has exactly one definition and one set of tests.

Everything here is **pure** — no I/O, no Convex, no React, no Node built-ins —
and consumed as TypeScript source. `apps/web` must list it in
`transpilePackages`.

```ts
import { can, EVENT_STATES, validateMediaFile } from "@partybooth/contracts";
```

Subpath imports (`@partybooth/contracts/permissions`, `/codes`, `/otp`, …) exist
for the cases where pulling the whole barrel is wasteful.

## Permissions

`can(role, action, resource)` is the single predicate. It is typed so that the
resource shape follows from the action — passing an event where media belongs
does not compile.

```ts
can("cohost", "media.moderate", {
  kind: "media",
  state: "pending",
  isOwn: false,
  event: { state: "live" },
}); // true
```

Three layers, in the order they are checked:

| Function                | Question                                                      |
| ----------------------- | ------------------------------------------------------------- |
| `hasCapability`         | Does this role ever get this action?                          |
| `can`                   | …and does the resource's state and ownership allow it now?    |
| `canAct` / `explainCan` | …and is the **actor's account** active enough to do anything? |

Use `canAct` on request paths, `can` when the account state is already known,
`explainCan` when the answer goes into an error message or an audit row.

The deliberate holes, all from `PLAN.md`:

- `globalAdmin` has **no** `media.*` capability at all, and `platform.viewMedia`
  / `platform.impersonateUser` are granted to nobody. They exist as actions so
  the rule is tested rather than implied.
- `cohost` gets every host power except the ones that change who owns the party:
  no `event.delete`, no `event.transferOwnership`, no settings edits, no
  co-host invites, no membership revocation, no hard-deleting media.
- An owner cannot `membership.leave` their own event — transfer it first.
- Ownership beats admin: if you are both, you act as the host.

`permissions.test.ts` holds a `Record<Action, readonly Role[]>` table covering
every action × role pair. Adding an action is a compile error until the table
is updated.

## State machines

`accountStateMachine`, `eventStateMachine`, `mediaStateMachine` and
`captureStateMachine` are built from one helper, so they all share two rules:

1. A transition to the state you are already in is a **no-op, not an error** —
   Convex mutations retry and callbacks arrive twice.
2. Terminal states are derived from the table, never hand-maintained.

`state-machine.test.ts` asserts structural invariants for all four (every state
reachable, no self-loops, exactly the intended terminals).

`HOST_SETTABLE_EVENT_STATES` is every event state **except**
`deletionScheduled`. Reaching that one has to go through the deletion flow,
which also writes the `deletionJobs` row that makes the 30-day restore window
real — so a generic "set the state" mutation must not offer it.

## Codes and tokens

- **Event code** — six digits. Uniform via rejection sampling (`byte % 10` would
  bias 0–5), and the guessable shapes (`111111`, `123456`, `987654`) are never
  emitted, which matters against a five-attempt budget. `generateUniqueEventCode`
  takes an async `isTaken` — uniqueness is a database property, and it is only
  required among **joinable** events.
- **Invite token** — 20 bytes as 32 Crockford base32 characters. Crockford
  because the token goes on printed signage: no I, L, O or U, and
  `normalizeInviteToken` folds the mistakes people still make.

Generation needs `globalThis.crypto` and is **server-side only**; clients call
the `normalize*` / `isValid*` halves. Both generators take an injectable
`randomBytes` so tests are deterministic.

The **join link** is here too — `joinPath`, `inviteUrl`, `joinFallbackUrl`,
`displayUrl`. That string has to agree in five places maintained by different
people: `apps/web`'s `/join/[token]` and `/join` routes, the iOS
associated-domains and Android App Links claims in `apps/mobile`, the QR matrix
the console renders, and the printed signage. Nothing builds one by
concatenation. What each app still decides for itself is the _origin_, which is
environment-dependent (`apps/web/src/lib/join-url.ts`).

## QR

`qr.ts` is a QR encoder: byte mode, error-correction level M, versions 1–10, in
and out as pure data (`encodeQr` → a boolean matrix; `qrPath` → an SVG path `d`).

It is in contracts rather than in an app because the same symbol comes out of two
front doors — the organiser console renders inline SVG today, and the app's host
tab renders the same matrix through `react-native-svg` in Sprint 5. Two encoders
would be two chances to print a code that scans on a laptop and not on a phone.
Rendering stays each app's business; only the bits are shared.

Why not a library: every QR package on npm is either an image encoder (canvas +
PNG, which we do not want) or drags in a byte-polyfill chain, and PLAN.md wants
the code generated client-side so no third-party image endpoint ever sees an
invite token. The golden matrix in `qr.test.ts` was cross-checked during
development against an independent encoder and round-tripped through a real
scanner; neither cross-check is committed, because both would be phantom
dependencies.

## Joining

`join.ts` holds the whole joining vocabulary: the input schema, the throttle
policy, the rejection reasons and the result shape.

The throttle is the same pure-function shape as the OTP one — `now` and a state
object in, the next state out — so the numbers are testable without a
deployment and identical on every client that displays them. Ten failures per
key in fifteen minutes starts a fifteen-minute lockout; a success hands the
budget back, so a guest mistyping in a dark hallway never accumulates one.
Keys are namespaced (`user:<id>`, `net:<hash>`) so an account key and a network
key can share one table.

`JOIN_REJECTION_REASONS` is **audit-only**. Every rejection returns
`joinRejected()` — one fixed sentence, no other fields — because a six-digit
code is a million values and two distinguishable answers is a working oracle.
`join.test.ts` asserts that property directly rather than trusting it.

Failures are values, not exceptions, for the same reason: a thrown error is a
different code path with different timing and a different shape on the wire.
`parseJoinResult` is where both clients turn a wire payload into one of those
values, and it **fails closed**: anything unparseable becomes the same rejection,
so "the backend said something I do not understand" never becomes a third,
distinguishable outcome.

`events.ts` owns the other half of joinability — `JOIN_WINDOW`,
`joinWindowStatus` and `eventJoinability`, which combine the state machine with
the schedule. The window opens thirty days before `startsAt` (printed signage
has to work early) and closes twelve hours after `endsAt` (the last guest is
always after the official end); an event with no `endsAt` never closes on time
alone.

## Uploads

`upload.ts` is the front half of the upload spine, and it is pure for the same
reason `join.ts` is: the policy has to be testable with no deployment and no
credentials, and the client has to be able to apply exactly the same rules
before it wastes a guest's bandwidth.

- `GRANT_POLICY` — a two-minute TTL, and sixty grants per account per five
  minutes. The TTL is measured to the point the upload _starts_, not finishes: a
  250 MB video on party wifi takes longer than that and is fine.
- `canIssueGrant` / `registerGrantIssued` — the same pure-function throttle shape
  as OTP and joining, but counting **successes**. An issued grant is the scarce
  thing, so there is no equivalent of joining's "nothing but time returns budget"
  argument; the window rolling over is the only reset either way.
- `checkGrantEligibility` — event state, then the host's library-import setting,
  then the file. The order is the point: a guest at a paused party is told the
  party is paused, not that their photo is 21 MB, because the first sentence is
  the one that explains why trying again smaller will not help.
- `matchesGrant` — what a completion has to prove. `byteSize` is always checked
  (it is the field the caps were enforced against); `checksum` only when the
  completion carries one, because the provider does not compute ours.
- `uploadReasonForFile` is the identity function, and that is deliberate: it
  compiles only while every `MediaRejectionReason` is also an
  `UploadRejectionReason`, so adding a file rejection without listing it is a
  type error rather than a `default:` branch reporting the wrong thing.

Unlike a join rejection, an upload rejection **is** returned in full. There is
nothing to enumerate: you cannot reach the mutation without an active membership
of the event you named, so every reason is a fact about your own file or about a
party you are already standing in.

Video is accepted here even though the capture UI is Sprint 4. `MEDIA_LIMITS`
already knows what a video may weigh and how long it may run, and a media type
that only becomes valid when a camera screen ships is a media type whose
validation gets written twice.

`canSeeMedia` in `media.ts` is the read-path half of the privacy invariant,
written as data rather than as an `if` in each of the three listing surfaces:
guests see `approved` plus every state of their **own** captures, hosts see
everything but `deleted`, and `globalAdmin` sees nothing at all.

## OTP policy

`OTP_POLICY` encodes PLAN.md's numbers — six digits, 10-minute expiry, five
attempts, 15-second resend cooldown — plus a per-hour send ceiling for
enumeration protection.

The module is split along the line of **who enforces what**, and holds nothing
that nobody calls:

- **Verification** (expiry, the five-guess budget, single use, hashing at rest)
  is Better Auth's `emailOTP` plugin. `packages/backend/convex/lib/otp.ts` hands
  it the numbers. There is deliberately no second `verifyOtp` here: a parallel
  implementation with its own tests and no callers reads as a guarantee and is
  not one.
- **Sending** is ours. `canSendOtp` / `registerOtpSend` / `OtpSendState` are
  called by `packages/backend/convex/otp.ts` on every OTP request, because
  Better Auth's own limiter defaults to per-isolate in-memory storage that
  Convex does not share.

Nothing here reads a clock or a database: every function takes `now` and a state
object and returns the next one, so the policy is testable without a deployment.

## Scrubbing

`@partybooth/contracts/scrub` is the single implementation of the Sentry
redaction rules — emails, JWTs, `Bearer` credentials, provider keys, inline
`token=`/`secret=` assignments, standalone six-digit OTP / join codes, signed
URLs and `/join/<token>` paths, plus wholesale replacement of sensitive keys.
`apps/web/src/lib/sentry-scrub.ts`, `apps/mobile/src/lib/scrub.ts` and
`packages/backend/convex/lib/sentry.ts` are all thin re-exports of it. It lives
here rather than in an app because three divergent copies is how an OTP ends up
scrubbed in one runtime and shipped verbatim from another.

## Adding to this package

1. Put the type and its zod schema in the matching module.
2. Export it from `src/index.ts`.
3. Add the test. Enum-shaped things belong in a `Record<…>` table so the
   compiler catches the next person who forgets.
4. If the backend stores it, add it to `packages/backend/convex/lib/validators.ts`
   — `schema.test.ts` fails if the database and the contract drift.
