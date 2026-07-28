/**
 * Turning a join attempt into something a guest can read.
 *
 * The hard constraint, straight out of `@partybooth/contracts/join`: **a rejection
 * carries no reason**. A six-digit code is a million values, so "no such code", "the
 * host rotated it" and "that party isn't open" are one indistinguishable answer on
 * the wire. This module must therefore never try to be more helpful than the backend
 * was — the moment it branches on anything that hints at the cause, the enumeration
 * protection the whole join flow is built around is gone.
 *
 * What it *can* do is separate the two things the guest genuinely does know about:
 * their own throttle state, and their own sign-in state. Both are facts about the
 * caller, not about the keyspace.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import {
  parseJoinResult as parseContractJoinResult,
  JOIN_REJECTED_MESSAGE,
  type JoinResult,
} from "@partybooth/contracts/join";

import { normaliseJoinCode } from "./deep-links";

import type { EventId, MembershipId } from "./api";

export type AppJoinResult = JoinResult<EventId, MembershipId>;

/**
 * The one sentence every refusal produces.
 *
 * Re-exported so screens reach it through this seam rather than importing contracts
 * directly — there must be exactly one string in the app, and a screen that invents a
 * second, more specific one has broken the enumeration protection.
 */
export { JOIN_REJECTED_MESSAGE };

/* -------------------------------------------------------------------------- */
/* Parsing what came back                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate a `join.join` response against the contract's own schema, narrowed to
 * the app's id aliases.
 *
 * `@partybooth/backend/client-api` *asserts* the wire shape with a cast; this
 * *proves* it. The cast is what the compiler sees, and it is only as good as the
 * hand-written table in that file — which cannot be checked against the deployment
 * until codegen is real. A malformed payload therefore has to fail as a rejection
 * rather than as an undefined property read three screens later, and it is
 * `@partybooth/contracts/join` that decides that, so `apps/web` fails the same way.
 */
export function parseJoinResult(value: unknown): AppJoinResult {
  return parseContractJoinResult<EventId, MembershipId>(value);
}

/* -------------------------------------------------------------------------- */
/* Explaining a failure                                                       */
/* -------------------------------------------------------------------------- */

export interface JoinFailureCopy {
  readonly title: string;
  /** The backend's own sentence — never a locally invented, more specific one. */
  readonly message: string;
  /** Extra guidance that is true for *every* rejection, so it leaks nothing. */
  readonly hint: string;
  /** Set only for a throttle, where the wait is the caller's own history. */
  readonly retryAfterMs?: number;
  /** Whether offering "try another code" makes sense right now. */
  readonly canRetry: boolean;
}

/**
 * Round a retry delay to something a human would say out loud.
 *
 * Deliberately coarse and always rounded **up**: a guest told "about a minute" who
 * retries at 59 seconds and is refused again learns nothing except that the app lies.
 */
export function formatRetryAfter(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "a moment";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "a minute";
  return `${minutes} minutes`;
}

export function describeJoinFailure(
  result: Extract<AppJoinResult, { outcome: "rejected" | "throttled" }>,
): JoinFailureCopy {
  if (result.outcome === "throttled") {
    return {
      title: "Too many tries",
      message: result.message,
      hint: `Wait about ${formatRetryAfter(result.retryAfterMs)}, then try the code again. Scanning the QR instead works straight away.`,
      retryAfterMs: result.retryAfterMs,
      canRetry: false,
    };
  }

  return {
    title: "That invite didn't work",
    // One sentence, from the contract. Everything specific stays in the audit log.
    message: result.message,
    hint: "Hosts rotate the code during a party, so an old sign or a screenshot goes stale. Ask whoever is hosting for the current one.",
    canRetry: true,
  };
}

/* -------------------------------------------------------------------------- */
/* The six-digit code field                                                   */
/* -------------------------------------------------------------------------- */

export const JOIN_CODE_LENGTH = 6;

export interface CodeFieldState {
  /** What the field should display: digits only, never more than six. */
  readonly digits: string;
  /** Six digits and accepted by the contract's own validator. */
  readonly complete: boolean;
  /**
   * Shown once the guest has typed enough to be wrong. Typing three digits is not
   * an error, it is progress, so this stays `null` until the field is full.
   */
  readonly error: string | null;
}

/**
 * Normalise a keystroke into field state.
 *
 * Everything that is not a digit is dropped rather than rejected. This is a code read
 * off a printed sign in a dark hallway and typed on a phone keyboard: paste brings
 * spaces and hyphens, some keyboards emit non-breaking spaces, and a guest who pastes
 * `428 913` means `428913`. `deep-links.normaliseJoinCode` runs the same lenient pass
 * before delegating the *shape* decision to `@partybooth/contracts/codes`, which is
 * the same function Convex validates with.
 */
export function readCodeInput(raw: string): CodeFieldState {
  const digits = raw.replace(/\D/g, "").slice(0, JOIN_CODE_LENGTH);
  if (digits.length < JOIN_CODE_LENGTH) {
    return { digits, complete: false, error: null };
  }
  const normalised = normaliseJoinCode(digits);
  if (normalised === null) {
    return { digits, complete: false, error: "Join codes are six digits." };
  }
  return { digits: normalised, complete: true, error: null };
}
