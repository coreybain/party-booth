"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BackendGate } from "@/components/backend-gate";
import { EventForm } from "@/components/events/event-form";
import { Button } from "@/components/ui/button";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi } from "@/lib/convex-api";

/**
 * Create an event, then go straight to its code and QR.
 *
 * The mutation returns the six digits and the token with the event id, because
 * a host who creates an event and immediately shows the QR is the common case,
 * not an edge — so there is no second round trip between "Create" and something
 * a guest can scan.
 *
 * `replace`, not `push`: the back button should return the host to their event
 * list, not to an empty create form for an event that now exists.
 */
export function CreateEvent({ nowMs }: { readonly nowMs: number }) {
  return (
    <BackendGate>
      <CreateEventLive nowMs={nowMs} />
    </BackendGate>
  );
}

function CreateEventLive({ nowMs }: { readonly nowMs: number }) {
  const router = useRouter();
  const create = useMutation(backendApi.events.create);

  return (
    <EventForm
      submitLabel="Create event"
      nowMs={nowMs}
      secondaryAction={
        <Link href="/dashboard">
          <Button variant="ghost" size="lg">
            Cancel
          </Button>
        </Link>
      }
      mode={{
        kind: "create",
        onSubmit: async (input) => {
          try {
            const result = await create(input);
            router.replace(`/events/${result.eventId}`);
          } catch (error) {
            // Rethrown as a plain message so the form shows it under the button
            // — `appErrorMessage` already turns "invitation-only beta" into a
            // sentence a first-time organiser can act on.
            throw new Error(appErrorMessage(error), { cause: error });
          }
        },
      }}
    />
  );
}
