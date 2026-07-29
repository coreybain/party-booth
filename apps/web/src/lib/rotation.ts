import {
  canRotateInvite,
  keepExistingMemberships,
  registerRotation,
  ROTATION_CONSEQUENCES,
  ROTATION_POLICY,
  type RotationAttemptState,
  type RotationChoice,
  type RotationConsequence,
} from "@/lib/contracts";

export { keepExistingMemberships, ROTATION_CONSEQUENCES };
export type { RotationChoice, RotationConsequence };

/**
 * Invite rotation, as a state machine and some sentences.
 *
 * Rotation is the one control in the organiser console that can take a party
 * away from thirty people who are standing in the room, so the shape of this
 * file is dictated by three rules rather than by convenience:
 *
 * 1. **The choice cannot be skipped.** `keepExistingMemberships` defaults to
 *    `true` in the contract, which is right for an API and wrong for a dialog: a
 *    host who presses "Rotate" without reading is a host who either kept a guest
 *    they meant to remove or removed thirty they meant to keep. So the modal
 *    opens with **no** choice selected and {@link canConfirmRotation} is `false`
 *    until one is made. That is the whole reason this is a machine rather than
 *    two booleans in a component.
 * 2. **The consequences are written out per choice**, in the same words for the
 *    same choice every time, because they are the only thing standing between a
 *    tired host at 1 a.m. and an irreversible sweep. Those sentences are
 *    `ROTATION_CONSEQUENCES` in `@partybooth/contracts/codes`, shared with the
 *    app's Host tab — this file re-exports them so call sites here read one
 *    import, but it does not own them.
 * 3. **The budget is the backend's budget.** `canRotateInvite` and
 *    `registerRotation` are the pure functions `convex/lib/rotation_throttle.ts`
 *    persists, so the countdown on a greyed-out button and the `rateLimited`
 *    refusal cannot disagree. The client's copy is optimistic — it only knows
 *    about rotations *this session* performed — so the server's `retryAfterMs`
 *    overrides it whenever one arrives.
 */

/* -------------------------------------------------------------------------- */
/* The modal's state                                                          */
/* -------------------------------------------------------------------------- */

/** What came back from a successful rotation. Structurally `RotateInviteResult`. */
export interface RotationOutcome {
  readonly version: number;
  readonly code: string;
  readonly token: string;
  readonly revokedMemberships: number;
}

export type RotationStep =
  /** The panel, with the modal shut. */
  | { readonly kind: "closed" }
  /** Open, waiting for the host to pick. `choice` is absent until they do. */
  | { readonly kind: "choosing"; readonly choice?: RotationChoice }
  | { readonly kind: "working"; readonly choice: RotationChoice }
  | { readonly kind: "done"; readonly choice: RotationChoice; readonly outcome: RotationOutcome }
  | {
      readonly kind: "failed";
      readonly choice: RotationChoice;
      readonly message: string;
      readonly retryAfterMs?: number;
    };

export type RotationEvent =
  | { readonly type: "open" }
  | { readonly type: "choose"; readonly choice: RotationChoice }
  | { readonly type: "confirm" }
  | { readonly type: "succeeded"; readonly outcome: RotationOutcome }
  | { readonly type: "failed"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly type: "close" };

export const initialRotationStep: RotationStep = { kind: "closed" };

/**
 * The only legal moves.
 *
 * `confirm` from `choosing` without a choice is deliberately a **no-op** rather
 * than an error: the button that would send it is disabled, and a keyboard
 * "Enter" on a form with nothing selected must not start a sweep.
 */
export function rotationReducer(step: RotationStep, event: RotationEvent): RotationStep {
  switch (event.type) {
    case "open":
      // Re-opening after a rotation starts blank. Carrying the previous choice
      // forward is how the second rotation of the night silently repeats the
      // first one's answer.
      return { kind: "choosing" };

    case "choose":
      return step.kind === "choosing" || step.kind === "failed"
        ? { kind: "choosing", choice: event.choice }
        : step;

    case "confirm":
      return step.kind === "choosing" && step.choice !== undefined
        ? { kind: "working", choice: step.choice }
        : step;

    case "succeeded":
      return step.kind === "working"
        ? { kind: "done", choice: step.choice, outcome: event.outcome }
        : step;

    case "failed":
      return step.kind === "working"
        ? {
            kind: "failed",
            choice: step.choice,
            message: event.message,
            ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
          }
        : step;

    case "close":
      return { kind: "closed" };
  }
}

/** Is the confirm button live? The rule that forces the choice. */
export function canConfirmRotation(step: RotationStep): boolean {
  return step.kind === "choosing" && step.choice !== undefined;
}

/** The chosen option, for a "failed" step's retry as well as a live one. */
export function chosenRotation(step: RotationStep): RotationChoice | undefined {
  return step.kind === "closed" ? undefined : step.kind === "choosing" ? step.choice : step.choice;
}

/* -------------------------------------------------------------------------- */
/* The budget                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What this session knows about the event's rotation budget.
 *
 * Two independent halves, and both matter. `attempts` is what we have watched
 * happen since the page loaded, run through the contract's own arithmetic;
 * `blockedUntil` is what the server told us when it refused. A reload throws the
 * first away — which is fine, because the second is authoritative and arrives
 * the moment it is needed.
 */
export interface RotationBudget {
  readonly attempts?: RotationAttemptState | undefined;
  readonly blockedUntil?: number | undefined;
}

export const emptyRotationBudget: RotationBudget = {};

export type RotationAvailability =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/** May the host rotate right now, and if not, for how much longer. */
export function rotationAvailability(budget: RotationBudget, now: number): RotationAvailability {
  const serverRemaining = budget.blockedUntil === undefined ? 0 : budget.blockedUntil - now;
  const local = canRotateInvite(budget.attempts, now);
  const localRemaining = local.allowed ? 0 : local.retryAfterMs;
  const remaining = Math.max(serverRemaining, localRemaining);
  return remaining > 0 ? { allowed: false, retryAfterMs: remaining } : { allowed: true };
}

/** Charge a rotation that actually happened. Successes only, like the backend. */
export function recordRotation(budget: RotationBudget, now: number): RotationBudget {
  return { ...budget, attempts: registerRotation(budget.attempts, now) };
}

/** Record a server refusal. `retryAfterMs` comes off the `rateLimited` error. */
export function recordRotationRefusal(
  budget: RotationBudget,
  now: number,
  retryAfterMs: number | undefined,
): RotationBudget {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return budget;
  return { ...budget, blockedUntil: now + retryAfterMs };
}

/** How many rotations are left in the window, for the "5 an hour" hint. */
export function rotationsRemaining(budget: RotationBudget, now: number): number {
  const attempts = budget.attempts;
  if (!attempts) return ROTATION_POLICY.maxPerWindow;
  if (now - attempts.windowStartedAt >= ROTATION_POLICY.windowMs) {
    return ROTATION_POLICY.maxPerWindow;
  }
  return Math.max(0, ROTATION_POLICY.maxPerWindow - attempts.count);
}

/**
 * "4 min" / "45 s" — a countdown a host can act on, rounded **up**.
 *
 * Rounding up matters: a button that says "0 s" and is still disabled reads as
 * broken, and one that says "1 min" and works at 58 seconds costs nobody
 * anything.
 */
export function formatRotationCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}
