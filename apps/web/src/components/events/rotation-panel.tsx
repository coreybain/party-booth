"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { CopyButton } from "@/components/events/copy-button";
import { Placeholder } from "@/components/layout/card";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Code } from "@/components/ui/code";
import { backendApi } from "@/lib/convex-api";
import { toAppErrorView } from "@/lib/app-errors";
import { groupJoinCode } from "@/lib/event-view";
import { joinUrl } from "@/lib/join-url";
import {
  canConfirmRotation,
  emptyRotationBudget,
  formatRotationCountdown,
  initialRotationStep,
  keepExistingMemberships,
  recordRotation,
  recordRotationRefusal,
  ROTATION_CONSEQUENCES,
  rotationAvailability,
  rotationReducer,
  rotationsRemaining,
  type RotationBudget,
  type RotationChoice,
  type RotationStep,
} from "@/lib/rotation";
import { useNow } from "@/lib/use-now";

/**
 * Invite rotation, from the host's side.
 *
 * Rotating is the most consequential single tap in the organiser console: it can
 * empty a party of thirty people who are standing in the room holding phones. So
 * the panel is a button that opens a dialog that will not let you past it until
 * you have said which of the two very different things you meant — see
 * `src/lib/rotation.ts`, where the machine and both sets of consequences live and
 * are unit tested.
 *
 * Three details that are not decoration:
 *
 * - **The new code is shown, big, with its QR, before the dialog closes.** A
 *   rotation that succeeds and then dumps you back on a page with the old
 *   number still cached is a host standing at the door with nothing to show.
 * - **The button greys out with a countdown** rather than offering a rotation
 *   the backend will refuse. The budget is `canRotateInvite` from the contracts,
 *   which is the *same* function `convex/lib/rotation_throttle.ts` persists — and
 *   the server's own `retryAfterMs` overrides it, because a page that has just
 *   loaded has counted nothing.
 * - **Nothing is optimistic.** `invites.current` is a live subscription, so the
 *   panel's idea of the current code is Convex's.
 */
export function RotationPanel({
  eventId,
  eventName,
  canRotate,
  className,
}: {
  readonly eventId: string;
  readonly eventName: string;
  /** `event.rotateInvite` needs an editable state — draft through paused. */
  readonly canRotate: boolean;
  readonly className?: string;
}) {
  const current = useQuery(backendApi.invites.current, { eventId });
  const rotate = useMutation(backendApi.invites.rotate);

  const [step, dispatch] = useReducer(rotationReducer, initialRotationStep);
  const [budget, setBudget] = useState<RotationBudget>(emptyRotationBudget);
  const now = useNow();

  /*
   * The budget is per-event, and the panel outlives the selection: switching
   * events in the header re-renders this with a new `eventId` and the previous
   * party's five-an-hour would follow it across.
   */
  const budgetEventId = useRef(eventId);
  useEffect(() => {
    if (budgetEventId.current !== eventId) {
      budgetEventId.current = eventId;
      setBudget(emptyRotationBudget);
      dispatch({ type: "close" });
    }
  }, [eventId]);

  const availability = rotationAvailability(budget, now);

  const confirm = useCallback(
    async (choice: RotationChoice) => {
      dispatch({ type: "confirm" });
      const at = Date.now();
      try {
        const outcome = await rotate({
          eventId,
          keepExistingMemberships: keepExistingMemberships(choice),
        });
        setBudget((previous) => recordRotation(previous, at));
        dispatch({ type: "succeeded", outcome });
      } catch (caught) {
        const view = toAppErrorView(caught);
        setBudget((previous) => recordRotationRefusal(previous, at, view.retryAfterMs));
        dispatch({
          type: "failed",
          message: view.message,
          ...(view.retryAfterMs === undefined ? {} : { retryAfterMs: view.retryAfterMs }),
        });
      }
    },
    [eventId, rotate],
  );

  if (current === undefined) {
    return (
      <div className={className} role="status" aria-live="polite">
        <span className="sr-only">Loading the current invite…</span>
        <div className="h-20 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  if (current === null) {
    return (
      <Placeholder className={className} title="No invite to rotate">
        This event has no active code yet. Its first one is minted when the event leaves draft.
      </Placeholder>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted">Current code</p>
          <p className="text-code mt-1 text-2xl font-semibold text-ink">
            {groupJoinCode(current.code)}
          </p>
          <p className="mt-1 text-sm text-faint">
            Invite #{current.version} · {rotationsRemaining(budget, now)} of 5 rotations left this
            hour
          </p>
        </div>

        <Button
          variant="danger"
          disabled={!canRotate || !availability.allowed || step.kind === "working"}
          onClick={() => {
            dispatch({ type: "open" });
          }}
        >
          {availability.allowed
            ? "Rotate the code"
            : `Wait ${formatRotationCountdown(availability.retryAfterMs)}`}
        </Button>
      </div>

      {canRotate ? null : (
        <Callout tone="info" className="mt-3">
          The code can only be rotated while the event is a draft, scheduled, live or paused.
        </Callout>
      )}

      {!availability.allowed && canRotate ? (
        <Callout tone="warning" className="mt-3" live="polite">
          This party has been rotated five times in the last hour. Every rotation writes an audit
          row for each guest it removes, so there is a ceiling on it. Try again in{" "}
          {formatRotationCountdown(availability.retryAfterMs)}.
        </Callout>
      ) : null}

      {step.kind === "closed" ? null : (
        <RotationDialog
          step={step}
          eventName={eventName}
          onChoose={(choice) => {
            dispatch({ type: "choose", choice });
          }}
          onConfirm={(choice) => {
            void confirm(choice);
          }}
          onClose={() => {
            dispatch({ type: "close" });
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                 */
/* -------------------------------------------------------------------------- */

type DialogStep = Exclude<RotationStep, { kind: "closed" }>;

function RotationDialog({
  step,
  eventName,
  onChoose,
  onConfirm,
  onClose,
}: {
  readonly step: DialogStep;
  readonly eventName: string;
  readonly onChoose: (choice: RotationChoice) => void;
  readonly onConfirm: (choice: RotationChoice) => void;
  readonly onClose: () => void;
}) {
  if (step.kind === "done") {
    return (
      <RotationResultPanel
        eventName={eventName}
        code={step.outcome.code}
        token={step.outcome.token}
        version={step.outcome.version}
        revoked={step.outcome.revokedMemberships}
        swept={step.choice === "revoke"}
        onClose={onClose}
      />
    );
  }

  const choice = step.choice;
  const working = step.kind === "working";

  return (
    <div className="mt-4 rounded-2xl border border-danger/40 bg-danger/5 p-4 sm:p-5">
      <h3 className="text-base font-semibold text-ink">Rotate the code for {eventName}?</h3>
      <p className="mt-1 text-sm text-muted">
        Choose what happens to the people already in. There is no default — this is the whole
        decision.
      </p>

      <fieldset className="mt-4 space-y-3" disabled={working}>
        <legend className="sr-only">What happens to existing guests</legend>
        {(["keep", "revoke"] as const).map((option) => {
          const copy = ROTATION_CONSEQUENCES[option];
          const selected = choice === option;
          return (
            <label
              key={option}
              className={`block cursor-pointer rounded-xl border p-4 transition-colors ${
                selected
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:border-line-strong"
              }`}
            >
              <span className="flex items-start gap-3">
                <input
                  type="radio"
                  name="rotation-choice"
                  value={option}
                  checked={selected}
                  onChange={() => {
                    onChoose(option);
                  }}
                  className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{copy.label}</span>
                  <span className="block text-sm text-muted">{copy.summary}</span>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                    {copy.effects.map((effect) => (
                      <li key={effect}>{effect}</li>
                    ))}
                  </ul>
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {step.kind === "failed" ? (
        <Callout tone="danger" live="assertive" className="mt-4">
          {step.message}
        </Callout>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="danger"
          loading={working}
          disabled={!canConfirmRotation(step)}
          onClick={() => {
            if (choice !== undefined) onConfirm(choice);
          }}
        >
          {choice === "revoke" ? "Rotate and remove everyone" : "Rotate the code"}
        </Button>
        <Button variant="ghost" disabled={working} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What the host holds up thirty seconds later.
 *
 * The QR is drawn from the token in the *result*, client-side, so the new symbol
 * exists before the subscription has caught up and no third-party image endpoint
 * ever sees an invite token.
 */
function RotationResultPanel({
  eventName,
  code,
  token,
  version,
  revoked,
  swept,
  onClose,
}: {
  readonly eventName: string;
  readonly code: string;
  readonly token: string;
  readonly version: number;
  readonly revoked: number;
  readonly swept: boolean;
  readonly onClose: () => void;
}) {
  const url = joinUrl(token);

  return (
    <div className="mt-4 rounded-2xl border border-positive/40 bg-positive/5 p-4 sm:p-5">
      <h3 className="text-base font-semibold text-ink">New code is live</h3>
      <p className="mt-1 text-sm text-muted">
        Invite #{version}. The old QR and the old six digits stopped working the moment this
        committed.{" "}
        {swept
          ? `${revoked === 1 ? "One guest was" : `${revoked} guests were`} removed and can re-join with the new code.`
          : "Everyone already in stayed in."}
      </p>

      <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-start">
        <div className="mx-auto w-full max-w-[12rem]">
          {url === undefined ? (
            <div className="grid aspect-square place-items-center rounded-2xl border border-dashed border-line p-4 text-center text-sm text-muted">
              Set <Code>NEXT_PUBLIC_SITE_URL</Code> to generate the QR code.
            </div>
          ) : (
            <QrCode value={url} label={`QR code to join ${eventName}`} className="p-3" />
          )}
        </div>

        <div className="space-y-3">
          <p className="text-code text-3xl font-semibold text-ink">{groupJoinCode(code)}</p>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={code} label="Copy code" />
            {url === undefined ? null : <CopyButton value={url} label="Copy join link" />}
          </div>
          <p className="text-sm text-faint">
            Anything printed with the old number is now wrong. Reprint it before the next guest
            arrives.
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The panel with nothing behind it — used while no event is selected. */
export function RotationPanelPlaceholder({ className }: { readonly className?: string }) {
  return (
    <Placeholder className={className} title="No event selected">
      Pick an event from the switcher at the top to rotate its code.
    </Placeholder>
  );
}
