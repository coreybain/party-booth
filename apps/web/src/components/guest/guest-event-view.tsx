"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BackendGate } from "@/components/backend-gate";
import {
  consoleMediaPanelFromHash,
  type ConsoleMediaPanel,
} from "@/components/events/guest-event-menu";
import { CapturePanel } from "@/components/guest/capture-panel";
import { EventGallery } from "@/components/guest/event-gallery";
import { MyMedia } from "@/components/guest/my-media";
import { CheckIcon } from "@/components/icons";
import { JoinLoading } from "@/components/join/join-states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/cn";
import type { EventSummary } from "@/lib/convex-api";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { galleryIsVisible, guestsCanUpload, uploadAvailabilityDescription } from "@/lib/event-view";
import { useCaptureUpload } from "@/lib/use-capture-upload";
import { useNow } from "@/lib/use-now";

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
  const now = useNow();
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
  const uploadsOpen = guestsCanUpload(event, now);

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
          ? event.state === "scheduled"
            ? "Pre-event uploads are open — you can start adding photos and video."
            : "The host has opened the event — you can start adding photos and video."
          : uploadAvailabilityDescription(event, now)}
      </Callout>

      <hr className="border-line" />

      <GuestCapture event={event} uploadsOpen={uploadsOpen} now={now} />

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
export function GuestCapture({
  event,
  uploadsOpen,
  now,
  layout = "stack",
}: {
  readonly event: EventSummary;
  readonly uploadsOpen: boolean;
  readonly now: number;
  readonly layout?: "stack" | "console";
}) {
  const controller = useCaptureUpload({
    eventId: event.id,
    state: event.state,
    allowLibraryImport: event.allowLibraryImport,
    ...(event.uploadStartsAt === undefined ? {} : { uploadStartsAt: event.uploadStartsAt }),
  });
  const galleryVisible = galleryIsVisible(event.state);
  const [consolePanel, setConsolePanel] = useState<ConsoleMediaPanel>("uploads");

  useEffect(() => {
    if (layout !== "console") return;

    const syncPanel = () => {
      const selected = consoleMediaPanelFromHash(window.location.hash, galleryVisible);
      setConsolePanel(selected);
    };

    syncPanel();
    window.addEventListener("hashchange", syncPanel);
    return () => {
      window.removeEventListener("hashchange", syncPanel);
    };
  }, [galleryVisible, layout]);

  useEffect(() => {
    if (layout !== "console") return;

    const targetId = consolePanel === "uploads" ? "your-uploads" : "party-gallery";
    if (window.location.hash !== `#${targetId}`) return;

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [consolePanel, layout]);

  return (
    <div
      className={cn(
        "space-y-8",
        layout === "console" &&
          "lg:grid lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] lg:items-start lg:gap-10 lg:space-y-0",
      )}
    >
      <div className={cn(layout === "console" && "lg:sticky lg:top-28")}>
        <CapturePanel
          controller={controller}
          uploadsOpen={uploadsOpen}
          allowLibraryImport={event.allowLibraryImport}
          closedReason={uploadAvailabilityDescription(event, now)}
        />
      </div>

      <div
        className={cn("space-y-8", layout === "console" && "lg:border-l lg:border-line lg:pl-10")}
      >
        <div hidden={layout === "console" && consolePanel !== "uploads"}>
          <MyMedia
            eventId={event.id}
            queue={controller.queue}
            onRetry={(captureId) => {
              void controller.send(captureId);
            }}
            onCancel={controller.cancel}
          />
        </div>

        {/*
          The approved gallery, below the guest's own uploads on purpose: the
          question a guest has just after sending something is "did mine work?",
          not "what else is there?".
        */}
        {galleryVisible ? (
          <div hidden={layout === "console" && consolePanel !== "gallery"}>
            <EventGallery eventId={event.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
