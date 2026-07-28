"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";

import { BackendGate } from "@/components/backend-gate";
import { CapturePanel } from "@/components/guest/capture-panel";
import { MyMedia } from "@/components/guest/my-media";
import { CheckIcon } from "@/components/icons";
import { JoinLoading } from "@/components/join/join-states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { EventSummary } from "@/lib/convex-api";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { EVENT_STATE_COPY, guestsCanUpload } from "@/lib/event-view";
import { useCaptureUpload } from "@/lib/use-capture-upload";

/**
 * Where a guest lands the moment they are in.
 *
 * Sprint 2's job ends at "you're in": capture is Sprint 3 and the gallery is
 * Sprint 4, so this screen exists to answer the only two questions a guest has
 * at this point — *did that work?* and *what happens next?* — and to be the
 * bookmarkable home the deep link, the app and the code path all converge on.
 *
 * It reads `events.home`, which is permission-checked in Convex and hides the
 * event behind a `notFound` from anyone with no relationship to it. The invite
 * code is host-only and simply is not in the payload for a guest, so there is
 * nothing here to hide in the UI.
 */
export function GuestEventView({ eventId }: { readonly eventId: string }) {
  return (
    <BackendGate>
      <GuestEventViewLive eventId={eventId} />
    </BackendGate>
  );
}

function GuestEventViewLive({ eventId }: { readonly eventId: string }) {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const home = useQuery(backendApi.events.home, isAuthenticated ? { eventId } : "skip");

  if (authLoading) return <JoinLoading />;

  if (!isAuthenticated) {
    return (
      <div className="space-y-5">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          Sign in to open this event
        </h1>
        <p className="text-sm text-muted">
          Scan the host's QR code again, or type the six-digit code from the sign.
        </p>
        <Link href="/join">
          <Button size="lg" fullWidth>
            Join with a code
          </Button>
        </Link>
      </div>
    );
  }

  if (home === undefined) return <JoinLoading />;

  const { event } = home;
  const uploadsOpen = guestsCanUpload(event.state);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-positive/15 text-positive"
          aria-hidden="true"
        >
          <CheckIcon size={20} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-positive">You're in</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight tracking-tight text-ink">
            {event.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
            <span className="text-faint">
              ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
            </span>
          </p>
        </div>
      </div>

      <Callout tone={uploadsOpen ? "success" : "info"} live="polite">
        {uploadsOpen
          ? "The host has opened the event — you can start adding photos and video."
          : EVENT_STATE_COPY[event.state].description}
      </Callout>

      <hr className="border-line" />

      <GuestCapture event={event} uploadsOpen={uploadsOpen} />

      {home.isHost ? (
        <Link href={`/events/${event.id}`} className="block">
          <Button variant="secondary" size="lg" fullWidth>
            Open the host console
          </Button>
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Capture and "My media", which share one controller.
 *
 * Split into its own component because `useCaptureUpload` is a hook and the
 * screen above it renders three different things before `events.home` resolves.
 * It is also the seam that keeps the two panels honest about each other: the
 * queue lives here, the capture card writes to it, and "My media" reads it —
 * so a retry offered in either place is the same retry, re-sending the same
 * bytes under the same `captureId`.
 */
function GuestCapture({
  event,
  uploadsOpen,
}: {
  readonly event: EventSummary;
  readonly uploadsOpen: boolean;
}) {
  const controller = useCaptureUpload({
    eventId: event.id,
    state: event.state,
    allowLibraryImport: event.allowLibraryImport,
  });

  return (
    <div className="space-y-8">
      <CapturePanel
        controller={controller}
        uploadsOpen={uploadsOpen}
        allowLibraryImport={event.allowLibraryImport}
        closedReason={EVENT_STATE_COPY[event.state].description}
      />

      <MyMedia
        eventId={event.id}
        queue={controller.queue}
        onRetry={(captureId) => {
          void controller.send(captureId);
        }}
        onCancel={controller.cancel}
      />
    </div>
  );
}
