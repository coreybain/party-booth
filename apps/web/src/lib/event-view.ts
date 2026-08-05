/**
 * Turning an event row into words on a screen.
 *
 * Pure and free of React so it can be unit-tested; every rule it applies comes
 * from `@partybooth/contracts`, so what the console *says* about an event and
 * what Convex will *allow* for it cannot disagree.
 */

import {
  acceptsUploads,
  eventAcceptsUploads,
  eventStateMachine,
  HOST_SETTABLE_EVENT_STATES,
  isEditableEventState,
  isJoinableEventState,
  isViewableEventState,
  type EventState,
  type HostSettableEventState,
  type LaunchModerationMode,
} from "./contracts";
import { formatRelative } from "./datetime";

export type StateTone = "neutral" | "positive" | "warning" | "danger";

interface StateCopy {
  readonly label: string;
  readonly tone: StateTone;
  /** One line the host can act on, shown under the badge. */
  readonly description: string;
}

export const EVENT_STATE_COPY: Readonly<Record<EventState, StateCopy>> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    description: "Only you can see it. The code and QR do not work yet.",
  },
  scheduled: {
    label: "Scheduled",
    tone: "neutral",
    description: "Guests can join and the QR works. Uploads open when you go live.",
  },
  live: {
    label: "Live",
    tone: "positive",
    description: "Guests can join and add photos and video.",
  },
  paused: {
    label: "Paused",
    tone: "warning",
    description: "Guests keep the gallery, but nothing new can be uploaded.",
  },
  archived: {
    label: "Archived",
    tone: "neutral",
    description: "Read-only. The code is free for another event to use.",
  },
  deletionScheduled: {
    label: "Deleting",
    tone: "danger",
    description: "Queued for removal. Nobody can open it.",
  },
};

export const MODERATION_MODE_COPY: Readonly<
  Record<LaunchModerationMode, { label: string; description: string }>
> = {
  manual: {
    label: "Review each one",
    description: "Nothing appears in the gallery or slideshow until you approve it.",
  },
  automatic: {
    label: "Publish straight away",
    description: "Everything appears immediately. You can still take anything down.",
  },
};

/** Which states this host may move to from the current one, in menu order. */
export function allowedNextStates(from: EventState): HostSettableEventState[] {
  return HOST_SETTABLE_EVENT_STATES.filter(
    (state) => state !== from && eventStateMachine.canTransition(from, state),
  );
}

/** The verb on the button, not the noun on the badge. */
export const STATE_ACTION_LABELS: Readonly<Record<HostSettableEventState, string>> = {
  draft: "Back to draft",
  scheduled: "Schedule",
  live: "Go live",
  paused: "Pause",
  archived: "Archive",
};

export interface EventStatusInput {
  readonly state: EventState;
  readonly startsAt: number;
  readonly endsAt?: number | undefined;
  readonly uploadStartsAt?: number | undefined;
}

export const END_EVENT_CONFIRMATION_SECONDS = 5;
export const LIVE_ENDING_SOON_MS = 2 * 60 * 60 * 1_000;
export const LIVE_ENDING_IMMINENT_MS = 30 * 60 * 1_000;

export type LiveEventTiming = "future" | "normal" | "soon" | "imminent";

/** One countdown tick; `undefined` disarms the end-event confirmation. */
export function tickEndEventConfirmation(remaining: number | undefined): number | undefined {
  if (remaining === undefined || remaining <= 1) return undefined;
  return remaining - 1;
}

/** The scheduled start time is still ahead. */
export function eventHasNotStarted(
  event: Pick<EventStatusInput, "startsAt">,
  now: number,
): boolean {
  return now < event.startsAt;
}

export type EventNowAction = "start" | "end";

/**
 * The immediate schedule action a host can take.
 *
 * A published event can still be scheduled for the future. In that case it is
 * live for guest access, but "Start now" remains the useful action because it
 * moves the scheduled start boundary to this moment.
 */
export function eventNowAction(
  event: Pick<EventStatusInput, "state" | "startsAt">,
  now: number,
): EventNowAction | undefined {
  if (!isEditableEventState(event.state)) return undefined;
  if (event.state === "live" && !eventHasNotStarted(event, now)) return "end";
  return "start";
}

/**
 * The live badge's time pressure, with a future start taking precedence over
 * its end time. An already-ended event is rendered by the separate past-event
 * treatment in the caller.
 */
export function liveEventTiming(
  event: Pick<EventStatusInput, "state" | "startsAt" | "endsAt">,
  now: number,
): LiveEventTiming | undefined {
  if (event.state !== "live") return undefined;
  if (eventHasNotStarted(event, now)) return "future";
  if (event.endsAt === undefined) return "normal";

  const remaining = event.endsAt - now;
  if (remaining <= LIVE_ENDING_IMMINENT_MS) return "imminent";
  if (remaining <= LIVE_ENDING_SOON_MS) return "soon";
  return "normal";
}

/** The schedule has a definite end and that moment has passed. */
export function eventHasEnded(event: Pick<EventStatusInput, "endsAt">, now: number): boolean {
  return event.endsAt !== undefined && now > event.endsAt;
}

/**
 * The single sentence at the top of the event home.
 *
 * The distinction that matters to a host on the night is between "guests can
 * get in" and "guests can upload" — scheduled events normally offer only the
 * first, unless the host configured a pre-event upload opening.
 */
export function eventStatusLine(event: EventStatusInput, now: number): string {
  const copy = EVENT_STATE_COPY[event.state];

  if (event.state === "scheduled") {
    if (eventAcceptsUploads(event, now)) {
      return "Pre-event uploads are open — guests can add photos and video now.";
    }
    return now < event.startsAt
      ? `Starts ${formatRelative(event.startsAt, now)} — guests can join now, ${
          event.uploadStartsAt === undefined
            ? "uploads open when you go live"
            : `uploads open ${formatRelative(event.uploadStartsAt, now)}`
        }.`
      : copy.description;
  }
  if (event.state === "live" && eventHasEnded(event, now)) {
    return "This event has ended — archive it when the last guest has gone.";
  }
  return copy.description;
}

/** Can a guest walk in right now? State only; the backend also checks the window. */
export function guestsCanJoin(state: EventState): boolean {
  return isJoinableEventState(state);
}

export function guestsCanUpload(
  event: EventState | Pick<EventStatusInput, "state" | "uploadStartsAt">,
  now = 0,
): boolean {
  if (typeof event === "string") return acceptsUploads(event);
  return eventAcceptsUploads(event, now);
}

/** One schedule-aware sentence for a closed guest capture panel. */
export function uploadAvailabilityDescription(
  event: Pick<EventStatusInput, "state" | "uploadStartsAt">,
  now: number,
): string {
  if (event.state === "scheduled" && event.uploadStartsAt !== undefined) {
    if (eventAcceptsUploads(event, now)) {
      return "Pre-event uploads are open — you can add photos and video now.";
    }
    return `You're in. Uploads open ${formatRelative(event.uploadStartsAt, now)}.`;
  }
  return EVENT_STATE_COPY[event.state].description;
}

export function galleryIsVisible(state: EventState): boolean {
  return isViewableEventState(state);
}

/** Whether the guest home should collapse to the single pre-event experience. */
export function guestEventIsWaiting(
  event: EventState | Pick<EventStatusInput, "state" | "uploadStartsAt">,
  now: number,
): boolean {
  const state = typeof event === "string" ? event : event.state;
  return state === "scheduled" && !guestsCanUpload(event, now);
}

export interface EventCountdown {
  readonly started: boolean;
  readonly totalSeconds: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

/** Stable clock parts for the guest pre-event countdown. */
export function eventCountdown(startsAt: number, now: number): EventCountdown {
  const totalSeconds = Math.max(0, Math.ceil((startsAt - now) / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return {
    started: now >= startsAt,
    totalSeconds,
    days,
    hours,
    minutes,
    seconds,
  };
}

/** "12 guests" / "1 guest", counting the host's own membership out. */
export function formatGuestCount(memberCount: number): string {
  const guests = Math.max(0, memberCount - 1);
  return `${String(guests)} guest${guests === 1 ? "" : "s"}`;
}

/** `482913` → `482 913`. Easier to read aloud across a noisy room. */
export function groupJoinCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
