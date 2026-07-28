"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { appErrorMessage } from "@/lib/app-errors";
import { parseJoinResult } from "@/lib/contracts";
import { backendApi, type JoinInvite } from "@/lib/convex-api";

/**
 * One join, however the guest arrived.
 *
 * A scanned QR and a typed six-digit code are two front doors onto one
 * mutation, and everything after the call is identical: parse the result, land
 * on the event, or turn a refusal into a state the page can render. That was
 * written out twice — once in `join-by-token.tsx`, once in `join-by-code.tsx` —
 * and the way that fails is specific and bad: one of the two copies acquires a
 * slightly more helpful error message, and the join path quietly becomes an
 * enumeration oracle. `apps/mobile` funnels its own two doors through
 * `useJoinEvent` for exactly this reason; this is the same shape.
 *
 * Two properties are load-bearing:
 *
 * - **A refusal is a value, not an exception.** `join.join` returns
 *   `{ outcome: "rejected" }` rather than throwing, because a thrown error is a
 *   different code path with different timing, and three distinguishable
 *   answers is an oracle. Anything that *is* thrown here is a real fault —
 *   offline, signed out, locked account — and gets the `error` phase.
 * - **The result is parsed, not trusted.** `@partybooth/backend/client-api` is
 *   a hand-written assertion until Convex codegen can introspect a deployment;
 *   `parseJoinResult` is the contract's own schema, and it fails *closed*.
 */

export type JoinPhase =
  | { readonly status: "idle" }
  | { readonly status: "joining" }
  /** Every rejection reason, wearing the one sentence the backend returns. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "throttled"; readonly message: string; readonly retryAfterMs: number }
  /** The call itself failed. Not a refusal — a fault. */
  | { readonly status: "error"; readonly message: string };

export interface JoinController {
  readonly phase: JoinPhase;
  readonly busy: boolean;
  /** Resolves once the outcome is known; navigation happens on success. */
  readonly attempt: (invite: JoinInvite) => Promise<JoinPhase>;
  readonly reset: () => void;
}

export function useJoinAttempt(): JoinController {
  const router = useRouter();
  const join = useMutation(backendApi.join.join);
  const [phase, setPhase] = useState<JoinPhase>({ status: "idle" });

  const attempt = useCallback(
    async (invite: JoinInvite): Promise<JoinPhase> => {
      setPhase({ status: "joining" });
      try {
        const result = parseJoinResult(await join({ invite }));

        if (result.outcome === "joined") {
          // `replace`, not `push`: the back button must not return a guest to a
          // join screen for an event they are already in.
          router.replace(`/event/${result.eventId}`);
          // Deliberately left on "joining" — the navigation is in flight and a
          // flash of the code form underneath it is worse than a held spinner.
          return { status: "joining" };
        }

        const next: JoinPhase =
          result.outcome === "throttled"
            ? {
                status: "throttled",
                message: result.message,
                retryAfterMs: result.retryAfterMs,
              }
            : { status: "rejected", message: result.message };
        setPhase(next);
        return next;
      } catch (error) {
        const next: JoinPhase = { status: "error", message: appErrorMessage(error) };
        setPhase(next);
        return next;
      }
    },
    [join, router],
  );

  const reset = useCallback(() => {
    setPhase({ status: "idle" });
  }, []);

  return { phase, busy: phase.status === "joining", attempt, reset };
}
