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
 * means *this* party, so the switch is explicit here.
 */

import { useMutation } from "convex/react";
import { useCallback, useState } from "react";

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
  /** A rejection or a throttle: an expected outcome of a normal flow, not a fault. */
  | { readonly status: "refused"; readonly copy: JoinFailureCopy }
  /** The call itself failed — offline, signed out, locked account. */
  | { readonly status: "error"; readonly copy: ErrorCopy };

export interface JoinController {
  readonly phase: JoinPhase;
  readonly busy: boolean;
  readonly attempt: (invite: JoinInvite) => Promise<JoinPhase>;
  readonly reset: () => void;
}

export function useJoinEvent(): JoinController {
  const join = useMutation(api.join.join);
  const { selectEvent } = useSession();
  const [phase, setPhase] = useState<JoinPhase>({ status: "idle" });

  const attempt = useCallback(
    async (invite: JoinInvite): Promise<JoinPhase> => {
      setPhase({ status: "joining" });
      try {
        // Parsed rather than trusted: `src/lib/api.ts` asserts the wire shape with a
        // hand-written cast, and until Convex codegen is real that cast is the only
        // thing checking it. `joinResultSchema` is the contract's own.
        const result = parseJoinResult(await join({ invite }));

        if (result.outcome === "joined") {
          // Failing to switch is not a failed join — they are in the party either
          // way, and the header will catch up on the next `activeEvent` value.
          await selectEvent(result.eventId);
          const next: JoinPhase = {
            status: "joined",
            eventId: result.eventId,
            alreadyMember: result.alreadyMember,
          };
          setPhase(next);
          return next;
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
    [join, selectEvent],
  );

  const reset = useCallback(() => setPhase({ status: "idle" }), []);

  return { phase, busy: phase.status === "joining", attempt, reset };
}
