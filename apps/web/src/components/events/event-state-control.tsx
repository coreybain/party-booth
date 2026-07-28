"use client";

import { useMutation } from "convex/react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi } from "@/lib/convex-api";
import { allowedNextStates, EVENT_STATE_COPY, STATE_ACTION_LABELS } from "@/lib/event-view";
import type { EventState, HostSettableEventState } from "@/lib/contracts";

/**
 * Moving an event through its lifecycle.
 *
 * The buttons offered are exactly `eventStateMachine`'s legal transitions from
 * the current state, filtered to the ones a host may set — so the console and
 * Convex cannot disagree about whether `archived → live` is a thing (it is: the
 * after-party). Nothing here decides policy; it reads it.
 *
 * `archived` asks for a confirmation because it is the one transition with a
 * side effect the host cannot see: archiving frees the six-digit code for
 * another event, so the printed sign stops working even if they re-open later.
 * That is exactly what `reissuedCode` reports back, and it is surfaced rather
 * than swallowed.
 */
export function EventStateControl({
  eventId,
  state,
}: {
  readonly eventId: string;
  readonly state: EventState;
}) {
  const setState = useMutation(backendApi.events.setState);
  const [pending, setPending] = useState<HostSettableEventState | undefined>(undefined);
  const [confirming, setConfirming] = useState<HostSettableEventState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reissuedCode, setReissuedCode] = useState<string | undefined>(undefined);

  const apply = useCallback(
    async (next: HostSettableEventState) => {
      setPending(next);
      setError(undefined);
      setConfirming(undefined);
      try {
        const result = await setState({ eventId, state: next });
        setReissuedCode(result.reissuedCode);
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(undefined);
      }
    },
    [eventId, setState],
  );

  const options = allowedNextStates(state);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{EVENT_STATE_COPY[state].description}</p>

      <div className="flex flex-wrap gap-2">
        {options.map((next) => (
          <Button
            key={next}
            variant={next === "live" ? "primary" : next === "archived" ? "danger" : "secondary"}
            loading={pending === next}
            disabled={pending !== undefined}
            onClick={() => {
              if (next === "archived") {
                setConfirming("archived");
                return;
              }
              void apply(next);
            }}
          >
            {STATE_ACTION_LABELS[next]}
          </Button>
        ))}
      </div>

      {confirming === "archived" ? (
        <Callout tone="warning" live="polite">
          <p className="text-ink">Archive this event?</p>
          <p className="mt-1">
            The gallery and slideshow stay available to everyone who joined, but nobody new can get
            in and the six-digit code becomes free for another event to use.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                void apply("archived");
              }}
            >
              Archive
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(undefined);
              }}
            >
              Keep it open
            </Button>
          </div>
        </Callout>
      ) : null}

      {reissuedCode === undefined ? null : (
        <Callout tone="warning" live="assertive">
          Somebody else had taken this event's old code while it was archived, so it now has a new
          one. Anything you printed with the old number is out of date.
        </Callout>
      )}

      {error === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      )}
    </div>
  );
}
