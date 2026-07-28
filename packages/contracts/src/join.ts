import { z } from "zod";

import { eventCodeSchema, inviteTokenSchema } from "./codes";
import { eventRoleSchema, type EventRole } from "./roles";

/**
 * Joining an event: the throttle policy, the rejection vocabulary, and the
 * result shape.
 *
 * Everything here is pure — `now` and a plain state object in, the next state
 * out — for the same reason `otp.ts` is: the policy has to be testable without
 * a deployment, and it has to be identical on every client that displays it.
 *
 * Two properties matter more than they look, both from PLAN.md:
 *
 * 1. **Enumeration protection.** A six-digit code is only a million values. A
 *    failed join must therefore look identical whether the code does not exist,
 *    belongs to a superseded invite version, or belongs to an event that is not
 *    joinable yet — see {@link JOIN_REJECTED_MESSAGE}. The *reason* is recorded
 *    in the audit log, never returned to the caller.
 * 2. **Per-account throttling.** The ceiling below is what turns "a million
 *    values" into "years of guessing", and it is enforced transactionally in a
 *    Convex mutation, exactly like the OTP send ceiling.
 */

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export const JOIN_POLICY = {
  /**
   * Failed attempts allowed per key per window before a lockout starts.
   *
   * Ten is deliberately generous for a human — a guest squinting at a poster in
   * a dark hallway gets plenty of goes — and brutal for a script: 10 guesses
   * per 15 minutes is ~35,000 a year against a keyspace of 10^6.
   */
  maxFailuresPerWindow: 10,
  failureWindowMs: 15 * 60 * 1000,
  /** How long a key stays locked out once the ceiling is hit. */
  lockoutMs: 15 * 60 * 1000,
} as const;

/**
 * What we persist per throttle key. No code, no event id: a throttle row must
 * never become a second place to learn which codes were tried.
 */
export interface JoinAttemptState {
  /** Failures inside the current window. */
  failureCount: number;
  windowStartedAt: number;
  lastAttemptAt: number;
  /**
   * Set once the ceiling is hit. Cleared **only by time** — see
   * {@link registerJoinFailure}. Nothing a caller can do on demand clears it.
   */
  lockedUntil?: number | undefined;
}

export type JoinThrottleDecision =
  { allowed: true } | { allowed: false; reason: "throttled"; retryAfterMs: number };

/**
 * Throttle keys.
 *
 * The account key is the one that always exists — joining is authenticated, so
 * there is always a user. The network key is separate and optional because a
 * Convex mutation has no client address; an HTTP-originated path (the web
 * join route) can hash one and pass it in, and the same table then holds both.
 * Keys are namespaced so the two can never collide.
 */
export function accountJoinKey(userId: string): string {
  return `user:${userId}`;
}

export function networkJoinKey(clientKeyHash: string): string {
  return `net:${clientKeyHash}`;
}

/** State for a key that has just failed for the first time. */
export function createJoinAttemptState(now: number): JoinAttemptState {
  return { failureCount: 1, windowStartedAt: now, lastAttemptAt: now };
}

/** May this key attempt a join right now? */
export function canAttemptJoin(
  state: JoinAttemptState | undefined,
  now: number,
): JoinThrottleDecision {
  if (state?.lockedUntil !== undefined && now < state.lockedUntil) {
    return { allowed: false, reason: "throttled", retryAfterMs: state.lockedUntil - now };
  }
  return { allowed: true };
}

/**
 * The state after a *failed* attempt.
 *
 * A window that has elapsed resets the count, so an occasional mistype never
 * accumulates into a lockout across an evening. Hitting the ceiling sets
 * `lockedUntil`; further failures while locked keep extending nothing — the
 * lock is already running and re-arming it on every retry would let a client
 * that loops lock itself out permanently.
 */
export function registerJoinFailure(
  state: JoinAttemptState | undefined,
  now: number,
): JoinAttemptState {
  if (state === undefined) return createJoinAttemptState(now);

  const lockElapsed = state.lockedUntil !== undefined && now >= state.lockedUntil;
  const windowElapsed = now - state.windowStartedAt >= JOIN_POLICY.failureWindowMs;

  if (lockElapsed || windowElapsed) return createJoinAttemptState(now);

  const failureCount = state.failureCount + 1;
  const alreadyLocked = state.lockedUntil !== undefined;

  return {
    failureCount,
    windowStartedAt: state.windowStartedAt,
    lastAttemptAt: now,
    ...(alreadyLocked
      ? { lockedUntil: state.lockedUntil }
      : failureCount >= JOIN_POLICY.maxFailuresPerWindow
        ? { lockedUntil: now + JOIN_POLICY.lockoutMs }
        : {}),
  };
}

/**
 * There is deliberately **no `registerJoinSuccess`**.
 *
 * There used to be, and it returned `{ failureCount: 0, lockedUntil: undefined }`
 * — a full reset of the budget on any admitted attempt. That is a complete
 * bypass of the ceiling this module exists to impose, because an admitted
 * attempt is not a scarce thing: `join` treats a *repeat* join by an existing
 * member as a success, so anyone holding one valid credential for any event —
 * their own party's code — could loop "nine wrong guesses, one replay of my own
 * code" forever and never reach ten failures in a window. 10^6 codes went from
 * years of guessing to an afternoon.
 *
 * Failures now age out one way only: {@link registerJoinFailure} starts a fresh
 * window once {@link JOIN_POLICY.failureWindowMs} has elapsed, and a lockout
 * ends when {@link JOIN_POLICY.lockoutMs} has elapsed. Time is the only thing
 * that hands the budget back, and time is the one resource an attacker cannot
 * manufacture. The cost to an honest guest is bounded and small: ten mistypes
 * inside fifteen minutes, and even those are forgiven fifteen minutes later.
 */

/* -------------------------------------------------------------------------- */
/* Rejection vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why a join was refused. **Audit-log and metrics only** — this value never
 * crosses the wire to the person who attempted the join, because telling them
 * apart is precisely what enumeration protection prevents.
 */
export const JOIN_REJECTION_REASONS = [
  /** No invite version anywhere holds that code or token. */
  "unknownCredential",
  /** The credential belongs to a superseded invite version. */
  "revokedVersion",
  /** The event exists but is in draft, archived or deletionScheduled. */
  "eventNotJoinable",
  /** Joinable state, but the schedule window is not open. */
  "outsideWindow",
  /** A previous membership for this event was revoked by a host. */
  "membershipRevoked",
] as const;

export type JoinRejectionReason = (typeof JOIN_REJECTION_REASONS)[number];

/**
 * The single sentence every rejection produces, regardless of reason.
 *
 * If this string is ever branched on, the enumeration protection is gone: an
 * attacker with a million codes and two distinguishable answers has a working
 * oracle. There is exactly one message on purpose.
 */
export const JOIN_REJECTED_MESSAGE =
  "That invite is not working. Check the code with whoever is hosting.";

export const JOIN_THROTTLED_MESSAGE = "Too many attempts. Try again in a few minutes.";

/* -------------------------------------------------------------------------- */
/* Input and result                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A guest arrives either from a QR / universal link (token) or by typing the
 * six-digit code. Both land in the same audited, throttled mutation.
 *
 * Re-exported from `schemas.ts` as `joinEventInputSchema` for continuity — this
 * module is where the joining vocabulary lives now.
 */
export const joinInputSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("token"), token: inviteTokenSchema }),
  z.object({ via: z.literal("code"), code: eventCodeSchema }),
]);
export type JoinInput = z.infer<typeof joinInputSchema>;

/**
 * The result of an attempt.
 *
 * Deliberately not an exception: a wrong code is an expected outcome of a
 * normal flow, and modelling it as a value keeps the failure paths identical —
 * same shape, same timing, same everything but the one field that says which.
 * `outcome` is `"rejected"` for every reason in {@link JOIN_REJECTION_REASONS};
 * `"throttled"` is the only other failure, and it depends solely on the
 * caller's own attempt history, which is not information they lack.
 *
 * The id types are parameters so the backend can narrow them to Convex's
 * branded `Id<"events">` while clients keep plain strings. Everything else
 * about the shape is fixed here.
 */
export interface JoinJoinedResult<
  TEventId extends string = string,
  TMembershipId extends string = string,
> {
  outcome: "joined";
  eventId: TEventId;
  membershipId: TMembershipId;
  role: EventRole;
  /** `true` when the user was already a member and nothing changed. */
  alreadyMember: boolean;
}

export interface JoinRejectedResult {
  outcome: "rejected";
  message: string;
}

export interface JoinThrottledResult {
  outcome: "throttled";
  message: string;
  retryAfterMs: number;
}

export type JoinResult<TEventId extends string = string, TMembershipId extends string = string> =
  JoinJoinedResult<TEventId, TMembershipId> | JoinRejectedResult | JoinThrottledResult;

/** The wire form, for a client that parses rather than trusts. */
export const joinResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("joined"),
    eventId: z.string(),
    membershipId: z.string(),
    role: eventRoleSchema,
    alreadyMember: z.boolean(),
  }),
  z.object({ outcome: z.literal("rejected"), message: z.string() }),
  z.object({
    outcome: z.literal("throttled"),
    message: z.string(),
    retryAfterMs: z.number().int().nonnegative(),
  }),
]);

/** The one rejection value, built in one place so it cannot drift. */
export function joinRejected(): JoinRejectedResult {
  return { outcome: "rejected", message: JOIN_REJECTED_MESSAGE };
}

/**
 * Parse a `join.join` response, treating anything unrecognisable as a
 * rejection.
 *
 * Both clients hand-write their view of the Convex API until codegen can
 * introspect a real deployment, so the compiler's idea of this payload is an
 * assertion rather than a proof. This function is the proof, and its
 * failure mode is the policy decision worth having in one place: a malformed
 * payload **fails closed**. Returning `undefined` or throwing would give the
 * two apps room to disagree about what an unparseable answer means, and
 * "unparseable" must never be a third, distinguishable outcome — that is a
 * shape an enumeration oracle can be built out of.
 */
export function parseJoinResult<
  TEventId extends string = string,
  TMembershipId extends string = string,
>(value: unknown): JoinResult<TEventId, TMembershipId> {
  const parsed = joinResultSchema.safeParse(value);
  if (!parsed.success) return joinRejected();
  return parsed.data as JoinResult<TEventId, TMembershipId>;
}

export function joinThrottled(retryAfterMs: number): JoinThrottledResult {
  return { outcome: "throttled", message: JOIN_THROTTLED_MESSAGE, retryAfterMs };
}
