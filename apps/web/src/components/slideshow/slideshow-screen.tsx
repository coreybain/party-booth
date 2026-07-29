"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { Card, Placeholder } from "@/components/layout/card";
import { Slide } from "@/components/slideshow/slide";
import { SlideshowControls } from "@/components/slideshow/slideshow-controls";
import { isHostRole, isViewableEventState } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import {
  currentId,
  initialSlideshowState,
  positionLabel,
  slideshowReducer,
  systemRng,
  upcomingId,
} from "@/lib/slideshow/machine";
import { useSlideshowFeed } from "@/lib/slideshow/use-slideshow-feed";
import { useWakeLock } from "@/lib/slideshow/use-wake-lock";

/**
 * The slideshow — a full-viewport, live-updating show for the television in the
 * corner of the room.
 *
 * PLAN.md: *"Slideshow: fullscreen, live-updating, photos + muted autoplay
 * video, pause/skip, chronological or shuffle, configurable photo timing."*
 *
 * The design constraint that decides everything is that **nobody is standing
 * next to the machine**. So:
 *
 * - the ordering, skipping and failure handling live in a tested reducer
 *   (`lib/slideshow/machine.ts`), not in effects;
 * - the feed accumulates rather than replaces, so an approval mid-slide adds a
 *   photo instead of restarting the show (`use-slideshow-feed.ts`);
 * - a screen wake lock is requested and **re-requested** whenever the tab
 *   becomes visible again, because the browser takes it away on every hide;
 * - controls fade out and every one of them has a keyboard shortcut;
 * - a media failure is a skip, not a stall, and the skip is permanent.
 *
 * Two layers are mounted at once — the outgoing slide and the incoming one — for
 * the crossfade. That is the only reason anything other than the current item is
 * in the DOM.
 *
 * Signed URLs expire on a clock rather than on a data change, so a show left
 * running re-reads the feed periodically (`REFRESH_INTERVAL_MS`) to re-mint
 * them. That is ADR 0004 §5's problem, and it is the one thing about this screen
 * that a five-hour party makes unavoidable.
 */

/** How often to re-read the feed so every signed URL is fresh. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** How long the controls stay up after the last sign of life. */
const CONTROLS_IDLE_MS = 3_500;

export function ActiveEventSlideshow() {
  return (
    <AuthenticatedBackendGate>
      <ActiveEventSlideshowLive />
    </AuthenticatedBackendGate>
  );
}

function ActiveEventSlideshowLive() {
  const active = useQuery(backendApi.events.activeEvent, {});

  if (active === undefined) {
    return (
      <Card>
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      </Card>
    );
  }

  if (active === null) {
    return (
      <Card>
        <Placeholder title="No event selected">
          Pick an event from the switcher at the top. The slideshow always shows one party.
        </Placeholder>
      </Card>
    );
  }

  // `slideshow.feed` needs `event.presentSlideshow`, which is an owner/co-host
  // power. Saying so beats letting Convex throw into the error boundary the
  // moment the stage mounts.
  if (!isHostRole(active.role)) {
    return (
      <Card>
        <Placeholder title="You're a guest at this party">
          The slideshow is run by the host. Switch to an event you host to present it.
        </Placeholder>
      </Card>
    );
  }

  /*
   * `slideshow.feed` intentionally requires a viewable event. Draft and
   * scheduled parties have no public gallery yet, so mounting the feed in those
   * states produces a correct backend refusal but an incorrect route crash.
   * Keep the stage unmounted until the event goes live.
   */
  if (!isViewableEventState(active.state)) {
    return (
      <Card>
        <Placeholder title="The slideshow isn't live yet">
          It will be ready here when you take the event live.
        </Placeholder>
      </Card>
    );
  }

  /*
   * Keyed on the event, which is the whole fix and not a nicety.
   *
   * `SlideshowStage` holds the accumulated playlist, the cursor, the refresh
   * timer and the reducer, and none of them are scoped to an event id. Without
   * the key, switching the active event in the switcher kept every one of them:
   * one party's photographs — and their still-valid signed URLs, good for the
   * rest of their ten minutes — carried on playing under the next party's name,
   * with that party's title across the top of the screen.
   */
  return <SlideshowStage key={active.id} eventId={active.id} eventName={active.name} />;
}

function SlideshowStage({
  eventId,
  eventName,
}: {
  readonly eventId: string;
  readonly eventName: string;
}) {
  const router = useRouter();
  const [refreshedAt, setRefreshedAt] = useState(0);
  const feed = useSlideshowFeed(eventId, refreshedAt);
  const [state, dispatch] = useReducer(slideshowReducer, initialSlideshowState);
  const [controlsVisible, setControlsVisible] = useState(true);

  const wakeLock = useWakeLock(!state.paused);

  /* -- the playlist ------------------------------------------------------ */

  // `reconciled`, not `appended`: the hook prunes items a host has declined or
  // revoked out of `feed.items`, and the reducer has to take them off the
  // playlist rather than keep playing them for the rest of the party.
  const feedKey = feed.items.map((item) => item.id).join(",");
  useEffect(() => {
    dispatch({
      type: "reconciled",
      ids: feedKey === "" ? [] : feedKey.split(","),
      rng: systemRng,
    });
  }, [feedKey]);

  /* -- fresh signed URLs ------------------------------------------------- */

  useEffect(() => {
    const timer = setInterval(() => {
      setRefreshedAt(Date.now());
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /* -- controls that hide ------------------------------------------------ */

  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      setControlsVisible(false);
    }, CONTROLS_IDLE_MS);
  }, []);

  useEffect(() => {
    // Start the hide countdown rather than calling `wake()`: the controls are
    // already visible on mount, so waking them would be a state write in an
    // effect body for a state that is already correct.
    idleTimer.current = setTimeout(() => {
      setControlsVisible(false);
    }, CONTROLS_IDLE_MS);

    const events: readonly (keyof WindowEventMap)[] = [
      "pointermove",
      "pointerdown",
      "keydown",
      "touchstart",
    ];
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, wake);
      if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  /* -- actions ----------------------------------------------------------- */

  const next = useCallback(() => {
    dispatch({ type: "advance", by: 1 });
  }, []);
  const previous = useCallback(() => {
    dispatch({ type: "advance", by: -1 });
  }, []);
  const onFailed = useCallback((id: string) => {
    dispatch({ type: "failed", id });
  }, []);
  const onDone = useCallback((id: string) => {
    // Named rather than blind: a timer belonging to the slide that has just been
    // skipped past must not advance the one that replaced it.
    dispatch({ type: "advanceFrom", id });
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === null) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  /* -- keyboard ---------------------------------------------------------- */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          dispatch({ type: "togglePause" });
          break;
        case "ArrowRight":
          event.preventDefault();
          dispatch({ type: "advance", by: 1 });
          break;
        case "ArrowLeft":
          event.preventDefault();
          dispatch({ type: "advance", by: -1 });
          break;
        case "s":
        case "S":
          dispatch({ type: "toggleOrder", rng: systemRng });
          break;
        case "m":
        case "M":
          dispatch({ type: "toggleMuted" });
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  /* -- render ------------------------------------------------------------ */

  const showing = currentId(state);
  const upcoming = upcomingId(state);
  const item = showing === undefined ? undefined : feed.byId.get(showing);
  const nextItem = upcoming === undefined ? undefined : feed.byId.get(upcoming);

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black">
      <div className="absolute inset-0">
        {/*
          Two layers, keyed on the item, so React mounts the incoming slide
          while the outgoing one is still fading. `active` decides which way each
          is going; the outgoing layer holds no timers because they are gated on
          it.
        */}
        {nextItem !== undefined && nextItem.id !== item?.id ? (
          <Slide
            key={nextItem.id}
            item={nextItem}
            active={false}
            muted={state.muted}
            paused
            slideSeconds={state.slideSeconds}
            onDone={onDone}
            onFailed={onFailed}
          />
        ) : null}

        {item === undefined ? (
          <EmptyStage
            eventName={eventName}
            loading={feed.loading}
            approved={feed.total}
            onExit={() => {
              router.push("/dashboard");
            }}
          />
        ) : (
          <Slide
            key={item.id}
            item={item}
            active
            muted={state.muted}
            paused={state.paused}
            slideSeconds={state.slideSeconds}
            onDone={onDone}
            onFailed={onFailed}
          />
        )}
      </div>

      {item !== undefined && controlsVisible ? (
        <p className="pointer-events-none absolute left-0 right-0 top-0 bg-gradient-to-b from-black/60 to-transparent p-4 text-sm text-white/80">
          {eventName} · {item.uploaderDisplayName}
        </p>
      ) : null}

      <SlideshowControls
        visible={controlsVisible}
        paused={state.paused}
        muted={state.muted}
        order={state.order}
        slideSeconds={state.slideSeconds}
        position={positionLabel(state)}
        wakeLockActive={wakeLock.active}
        wakeLockSupported={wakeLock.supported}
        onTogglePause={() => {
          dispatch({ type: "togglePause" });
        }}
        onNext={next}
        onPrevious={previous}
        onToggleOrder={() => {
          dispatch({ type: "toggleOrder", rng: systemRng });
        }}
        onToggleMuted={() => {
          dispatch({ type: "toggleMuted" });
        }}
        onSlideSeconds={(seconds) => {
          dispatch({ type: "setSlideSeconds", seconds });
        }}
        onFullscreen={toggleFullscreen}
        onExit={() => {
          router.push("/dashboard");
        }}
      />
    </div>
  );
}

/**
 * Nothing to show — which at the start of a party is the normal state, not an
 * error. It says what has to happen next and by whom.
 */
function EmptyStage({
  eventName,
  loading,
  approved,
  onExit,
}: {
  readonly eventName: string;
  readonly loading: boolean;
  readonly approved: number;
  readonly onExit: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <h1 className="text-2xl font-semibold text-white">{eventName}</h1>
      <p className="max-w-md text-white/70">
        {loading
          ? "Loading the party…"
          : approved > 0
            ? "Nothing here can be shown right now — every approved item failed to load. It will pick up again as new photos are approved."
            : "Nothing approved yet. Approved photos and video appear here the moment you approve them, without touching this screen."}
      </p>
      <button
        type="button"
        onClick={onExit}
        className="mt-2 rounded-xl border border-white/25 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
      >
        Back to the console
      </button>
    </div>
  );
}
