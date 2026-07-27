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

## OTP policy

`OTP_POLICY` encodes PLAN.md's numbers — six digits, 10-minute expiry, five
attempts, 60-second resend cooldown — plus a per-hour send ceiling for
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
