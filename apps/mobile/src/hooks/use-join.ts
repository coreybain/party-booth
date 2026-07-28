/**
 * One join, however the guest arrived.
 *
 * A QR scan, a `partybooth://` link and a typed six-digit code are three front doors
 * onto one mutation, and the interesting behaviour — parse the result, translate a
 * failure, point the shell at the party on success — is identical for all three. It
 * lives here so the two screens cannot drift apart, which is how one of them ends up
 * with a slightly-too-helpful error message and quietly becomes an enumeration oracle.
 *
 * Success does **not** rely on the backend switching the active event: `join.join`
 * only adopts an event when the caller had no usable one (`adoptActiveEvent`), which
 * is right for a first join and wrong for the second. Someone who just scanned a QR
 * means *this* party, so the switch is explicit here — and because the backend
 * deliberately preserves a still-valid existing selection, this switch is the **only**
 * thing pointing the Camera at the new party for a guest who is already at another.
 *
 * That makes a failed switch a failed journey rather than a cosmetic hiccup, so it has
 * its own terminal state and its own retry. Reporting `joined` and navigating to
 * Camera anyway is how somebody ends up sending photos to last week's party.
 */

import { useMutation } from "convex/react";
import { useCallback, useRef, useState } from "react";

import { api, type EventId, type JoinInvite } from "../lib/api";
import { describeError, type ErrorCopy } from "../lib/errors";
import { describeJoinFailure, parseJoinResult, type JoinFailureCopy } from "../lib/join";
import { captureHandledError } from "../lib/sentry";
import { useSession } from "../providers/session";

export type JoinPhase =
  | { readonly status: "idle" }
  | { readonly status: "joining" }
  | {
      readonly status: "joined";
      readonly eventId: EventId;
      /** `true` when nothing changed — the UI says "you're already in" rather than "welcome". */
      readonly alreadyMember: boolean;
    }
  /**
   * In the party, but the app is still pointed at a different one.
   *
   * The membership exists and nothing about it needs redoing; what failed is the
   * active-event switch, which is retryable on its own.
   */
  | {
      readonly status: "switch-failed";
      readonly eventId: EventId;
      readonly alreadyMember: boolean;
      readonly copy: ErrorCopy;
    }
  /** A rejection or a throttle: an expected outcome of a normal flow, not a fault. */
  | { readonly status: "refused"; readonly copy: JoinFailureCopy }
  /** The call itself failed — offline, signed out, locked account. */
  | { readonly status: "error"; readonly copy: ErrorCopy };

export interface JoinController {
  readonly phase: JoinPhase;
  readonly busy: boolean;
  readonly attempt: (invite: JoinInvite) => Promise<JoinPhase>;
  /** Retry the active-event switch alone, from `switch-failed`. */
  readonly retrySwitch: () => Promise<JoinPhase>;
  readonly reset: () => void;
}

export function useJoinEvent(): JoinController {
  const join = useMutation(api.join.join);
  const { selectEvent } = useSession();
  const [phase, setPhase] = useState<JoinPhase>({ status: "idle" });
  /** Guards the retry against a double tap while a switch is in flight. */
  const switching = useRef(false);

  const landOn = useCallback(
    async (eventId: EventId, alreadyMember: boolean): Promise<JoinPhase> => {
      const outcome = await selectEvent(eventId);
      const next: JoinPhase =
        outcome.status === "ok"
          ? { status: "joined", eventId, alreadyMember }
          : {
              status: "switch-failed",
              eventId,
              alreadyMember,
              copy: {
                title: "Almost in",
                message: `You're in the party, but the app is still pointed at another one. ${outcome.message}`,
                recovery: "retry",
              },
            };
      setPhase(next);
      return next;
    },
    [selectEvent],
  );

  const attempt = useCallback(
    async (invite: JoinInvite): Promise<JoinPhase> => {
      setPhase({ status: "joining" });
      try {
        // Parsed rather than trusted: `src/lib/api.ts` asserts the wire shape with a
        // hand-written cast, and until Convex codegen is real that cast is the only
        // thing checking it. `joinResultSchema` is the contract's own.
        const result = parseJoinResult(await join({ invite }));

        if (result.outcome === "joined") {
          return await landOn(result.eventId, result.alreadyMember);
        }

        const next: JoinPhase = { status: "refused", copy: describeJoinFailure(result) };
        setPhase(next);
        return next;
      } catch (error) {
        // A refused join is a value, so anything thrown here is a real fault worth
        // reporting: a dropped connection, an expired session, a locked account.
        captureHandledError(error, { scope: "join.attempt", via: invite.via });
        const next: JoinPhase = { status: "error", copy: describeError(error) };
        setPhase(next);
        return next;
      }
    },
    [join, landOn],
  );

  const retrySwitch = useCallback(async (): Promise<JoinPhase> => {
    if (phase.status !== "switch-failed" || switching.current) return phase;
    switching.current = true;
    try {
      // No second `join.join`: the membership is already there, and spending a
      // throttle slot to re-learn that is the wrong kind of retry.
      return await landOn(phase.eventId, phase.alreadyMember);
    } finally {
      switching.current = false;
    }
  }, [landOn, phase]);

  const reset = useCallback(() => setPhase({ status: "idle" }), []);

  return { phase, busy: phase.status === "joining", attempt, retrySwitch, reset };
}
