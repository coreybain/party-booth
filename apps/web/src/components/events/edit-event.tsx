"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BackendGate } from "@/components/backend-gate";
import { EventForm } from "@/components/events/event-form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi } from "@/lib/convex-api";
import { eventToFormValues } from "@/lib/event-form";
import { isEditableEventState } from "@/lib/contracts";

/**
 * Edit an event's settings.
 *
 * The form is only mounted once the current values have loaded, so its initial
 * state is the real one — a form that starts blank and fills itself in is a
 * form that saves an empty name if the host is quick.
 *
 * An archived event is read-only: `EDITABLE_EVENT_STATES` in the contract says
 * so, and Convex refuses the mutation, so the console says why rather than
 * offering fields that will bounce.
 */
export function EditEvent({
  eventId,
  nowMs,
}: {
  readonly eventId: string;
  readonly nowMs: number;
}) {
  return (
    <BackendGate>
      <EditEventLive eventId={eventId} nowMs={nowMs} />
    </BackendGate>
  );
}

function EditEventLive({ eventId, nowMs }: { readonly eventId: string; readonly nowMs: number }) {
  const router = useRouter();
  const home = useQuery(backendApi.events.home, { eventId });
  const update = useMutation(backendApi.events.update);

  if (home === undefined) {
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <span className="sr-only">Loading the event…</span>
        <div className="h-48 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
        <div className="h-48 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  if (!isEditableEventState(home.event.state)) {
    return (
      <Callout tone="info" title="This event is closed to edits">
        <p>
          {home.event.state === "archived"
            ? "An archived event keeps its gallery but nothing about it can be changed. Re-open it from the event home if the party is back on."
            : "This event is on its way out and cannot be changed."}
        </p>
        <Link href={`/events/${eventId}`} className="mt-3 inline-block">
          <Button variant="secondary" size="sm">
            Back to the event
          </Button>
        </Link>
      </Callout>
    );
  }

  const initialValues = eventToFormValues(home.event);

  return (
    <EventForm
      submitLabel="Save changes"
      nowMs={nowMs}
      secondaryAction={
        <Link href={`/events/${eventId}`}>
          <Button variant="ghost" size="lg">
            Cancel
          </Button>
        </Link>
      }
      mode={{
        kind: "edit",
        eventId,
        initialValues,
        onSubmit: async (input) => {
          try {
            await update(input);
            router.replace(`/events/${eventId}`);
          } catch (error) {
            throw new Error(appErrorMessage(error), { cause: error });
          }
        },
      }}
    />
  );
}
