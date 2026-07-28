"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";

import { BackendGate } from "@/components/backend-gate";
import { CheckIcon } from "@/components/icons";
import { Placeholder } from "@/components/layout/card";
import { JoinLoading } from "@/components/join/join-states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { EVENT_STATE_COPY, guestsCanUpload } from "@/lib/event-view";

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

      <Placeholder title="Camera and gallery" sprint="Sprint 3–4">
        Taking a photo or video, seeing what you have submitted and browsing the approved gallery
        all land here. Nothing you add is public — only people at this event can see it.
      </Placeholder>

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
