"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { BackendGate } from "@/components/backend-gate";
import {
  consoleMediaPanelFromHash,
  type ConsoleMediaPanel,
} from "@/components/events/guest-event-menu";
import { CapturePanel } from "@/components/guest/capture-panel";
import { EventGallery } from "@/components/guest/event-gallery";
import { GuestAppPrompt, useGuestAppPrompt } from "@/components/guest/guest-app-prompt";
import { GuestEventSettings } from "@/components/guest/guest-event-settings";
import {
  GuestEventTabPanel,
  GuestEventTabs,
  guestEventTabFromHash,
  type GuestEventTab,
} from "@/components/guest/guest-event-tabs";
import { MyMedia } from "@/components/guest/my-media";
import { CheckIcon, LogoMark } from "@/components/icons";
import { JoinLoading } from "@/components/join/join-states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/cn";
import type { EventHome, EventSummary } from "@/lib/convex-api";
import { backendApi } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import {
  eventCountdown,
  galleryIsVisible,
  guestEventIsWaiting,
  guestsCanUpload,
  uploadAvailabilityDescription,
} from "@/lib/event-view";
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
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const home = useQuery(backendApi.events.home, isAuthenticated ? { eventId } : "skip");
  // A future scheduled event owns a seconds-accurate countdown. Every other
  // event keeps the shared 30-second clock used by relative-time copy.
  const now = useNow(home?.event.state === "scheduled" ? 1_000 : undefined);
  const [celebrating, setCelebrating] = useState(false);
  const previousUploadsOpen = useRef<boolean | undefined>(undefined);
  const hasHome = home !== undefined;
  const uploadsOpen = hasHome ? guestsCanUpload(home.event, now) : false;

  useEffect(() => {
    if (!hasHome) return;

    const wasOpen = previousUploadsOpen.current;
    previousUploadsOpen.current = uploadsOpen;
    if (wasOpen !== false || !uploadsOpen) return;

    setCelebrating(true);
    const timer = window.setTimeout(() => {
      setCelebrating(false);
    }, 2_400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [hasHome, uploadsOpen]);

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

  return (
    <div>
      {celebrating ? <EventStartCelebration /> : null}
      <GuestEventWebApp home={home} uploadsOpen={uploadsOpen} now={now} />
    </div>
  );
}

/** The three-area mobile-web shell, backed by one persistent upload controller. */
function GuestEventWebApp({
  home,
  uploadsOpen,
  now,
}: {
  readonly home: EventHome;
  readonly uploadsOpen: boolean;
  readonly now: number;
}) {
  const { event } = home;
  const controller = useCaptureUpload({
    eventId: event.id,
    state: event.state,
    allowLibraryImport: event.allowLibraryImport,
    ...(event.uploadStartsAt === undefined ? {} : { uploadStartsAt: event.uploadStartsAt }),
  });
  const [activeTab, setActiveTab] = useState<GuestEventTab>("camera");
  const appPrompt = useGuestAppPrompt();
  const waitingForEvent = guestEventIsWaiting(event, now);
  const galleryVisible = galleryIsVisible(event.state);

  useEffect(() => {
    const syncFromHash = () => setActiveTab(guestEventTabFromHash(window.location.hash));
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const openTab = useCallback((tab: GuestEventTab) => {
    setActiveTab(tab);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${tab}`,
    );
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);

  return (
    <div
      className={cn("space-y-6", activeTab === "camera" && appPrompt.visible && "pb-40 sm:pb-36")}
    >
      <GuestEventTabs active={activeTab} onChange={openTab} />

      <GuestEventTabPanel tab="camera" active={activeTab} className="space-y-6">
        <EventWelcome event={event} />

        {waitingForEvent ? (
          <PreEventCountdown startsAt={event.startsAt} now={now} />
        ) : (
          <>
            <Callout tone={uploadsOpen ? "success" : "info"} live="polite">
              {uploadsOpen
                ? event.state === "scheduled"
                  ? "Pre-event uploads are open — you can start adding photos and video."
                  : "The event is live — you can start adding photos and video."
                : uploadAvailabilityDescription(event, now)}
            </Callout>

            <CapturePanel
              controller={controller}
              uploadsOpen={uploadsOpen}
              allowLibraryImport={event.allowLibraryImport}
              closedReason={uploadAvailabilityDescription(event, now)}
              showHeading={false}
            />
          </>
        )}
      </GuestEventTabPanel>

      <GuestEventTabPanel tab="gallery" active={activeTab} className="space-y-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Gallery</h1>
          <p className="mt-1 text-sm text-muted">Photos and videos from {event.name}.</p>
        </div>

        <MyMedia
          eventId={event.id}
          queue={controller.queue}
          onRetry={(captureId) => {
            void controller.send(captureId);
          }}
          onCancel={controller.cancel}
        />

        {galleryVisible ? <EventGallery eventId={event.id} /> : null}
      </GuestEventTabPanel>

      <GuestEventTabPanel tab="settings" active={activeTab}>
        <GuestEventSettings eventId={event.id} isHost={home.isHost} onOpenTab={openTab} />
      </GuestEventTabPanel>

      {activeTab === "camera" && appPrompt.visible ? (
        <GuestAppPrompt onDismiss={appPrompt.dismiss} />
      ) : null}
    </div>
  );
}

function EventWelcome({ event }: { readonly event: EventSummary }) {
  return (
    <header className="flex items-start gap-3">
      <span
        className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-positive/15 text-positive"
        aria-hidden="true"
      >
        <CheckIcon size={21} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-positive">You're in</p>
        <h1 className="mt-0.5 text-2xl font-semibold leading-tight tracking-tight text-ink">
          {event.name}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
          <span className="text-faint">
            ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
          </span>
        </p>
      </div>
    </header>
  );
}

const COUNTDOWN_PARTS = [
  ["days", "days"],
  ["hours", "hours"],
  ["minutes", "mins"],
  ["seconds", "secs"],
] as const;

/** One pre-event promise, rather than three inactive upload sections. */
function PreEventCountdown({ startsAt, now }: { readonly startsAt: number; readonly now: number }) {
  const countdown = eventCountdown(startsAt, now);

  return (
    <section
      className="relative isolate overflow-hidden rounded-2xl border border-accent/25 bg-accent-soft/45 px-5 py-6 sm:px-7 sm:py-7"
      aria-labelledby="event-countdown-heading"
    >
      <div
        className="pointer-events-none absolute -right-12 -top-16 size-40 rounded-full border border-accent/20"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -right-2 -top-7 size-20 rounded-full border border-info/20"
        aria-hidden="true"
      />

      <div className="relative">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent">
          <LogoMark size={18} />
          {countdown.started ? "Starting soon" : "Countdown to party time"}
        </div>

        <h2
          id="event-countdown-heading"
          className="mt-4 text-xl font-semibold tracking-tight text-ink"
        >
          {countdown.started ? "It’s party time" : "The event hasn’t started yet"}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
          {countdown.started
            ? "Uploads will open here as soon as the host starts the event. You won’t need to refresh."
            : "You’ll be able to take and upload photos and videos when the event starts. Keep this page open — it’ll switch over automatically."}
        </p>

        {countdown.started ? (
          <div className="mt-6 flex items-center gap-3 text-sm font-medium text-ink" role="status">
            <span className="relative flex size-3" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex size-3 rounded-full bg-accent" />
            </span>
            Waiting for the host to open uploads…
          </div>
        ) : (
          <div
            className="mt-6 grid grid-cols-4 gap-2 sm:gap-3"
            role="timer"
            aria-label={`${String(countdown.days)} days, ${String(countdown.hours)} hours, ${String(countdown.minutes)} minutes and ${String(countdown.seconds)} seconds until the event starts`}
          >
            {COUNTDOWN_PARTS.map(([key, label], index) => (
              <div key={key} className="relative min-w-0 text-center">
                {index > 0 ? (
                  <span
                    className="absolute -left-1 top-1 text-lg font-semibold text-faint sm:-left-2 sm:text-xl"
                    aria-hidden="true"
                  >
                    :
                  </span>
                ) : null}
                <span className="block tabular-nums text-[clamp(1.55rem,8vw,2.35rem)] font-semibold leading-none tracking-[-0.04em] text-ink">
                  {String(countdown[key]).padStart(2, "0")}
                </span>
                <span className="mt-2 block text-[0.62rem] font-medium uppercase tracking-[0.16em] text-faint sm:text-xs">
                  {label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface ConfettiPiece {
  readonly left: number;
  readonly drift: number;
  readonly rotation: number;
  readonly delay: number;
  readonly duration: number;
  readonly color: string;
  readonly round: boolean;
}

const CONFETTI: readonly ConfettiPiece[] = Array.from({ length: 28 }, (_, index) => ({
  left: (index * 37 + 11) % 100,
  drift: ((index * 29) % 42) - 21,
  rotation: 240 + ((index * 47) % 420),
  delay: (index % 7) * 55,
  duration: 1_450 + ((index * 83) % 550),
  color: ["#ff4d8d", "#34d399", "#60a5fa", "#fbbf24", "#f5f3f8"][index % 5] ?? "#ff4d8d",
  round: index % 3 === 0,
}));

type ConfettiStyle = CSSProperties & {
  "--confetti-drift": string;
  "--confetti-rotation": string;
};

/** A single, non-blocking celebration when reactive event state opens uploads. */
function EventStartCelebration() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden="true">
      <div className="absolute left-1/2 top-[max(5rem,env(safe-area-inset-top))] -translate-x-1/2 animate-[party-banner_2200ms_cubic-bezier(0.16,1,0.3,1)_both] rounded-full border border-accent/30 bg-surface/95 px-5 py-3 text-sm font-semibold text-ink shadow-2xl shadow-accent/20 motion-reduce:hidden">
        Party time — uploads are open
      </div>
      <div className="motion-reduce:hidden">
        {CONFETTI.map((piece, index) => (
          <span
            key={`${String(piece.left)}-${String(index)}`}
            className="absolute -top-4 block h-3 w-2 animate-[party-confetti_1800ms_cubic-bezier(0.22,1,0.36,1)_both]"
            style={
              {
                left: `${String(piece.left)}%`,
                backgroundColor: piece.color,
                borderRadius: piece.round ? "999px" : "2px",
                animationDelay: `${String(piece.delay)}ms`,
                animationDuration: `${String(piece.duration)}ms`,
                "--confetti-drift": `${String(piece.drift)}vw`,
                "--confetti-rotation": `${String(piece.rotation)}deg`,
              } as ConfettiStyle
            }
          />
        ))}
      </div>
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
