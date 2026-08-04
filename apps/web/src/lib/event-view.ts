/**
 * Turning an event row into words on a screen.
 *
 * Pure and free of React so it can be unit-tested; every rule it applies comes
 * from `@partybooth/contracts`, so what the console *says* about an event and
 * what Convex will *allow* for it cannot disagree.
 */

import {
  acceptsUploads,
  eventStateMachine,
  HOST_SETTABLE_EVENT_STATES,
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
}

/** The schedule has a definite end and that moment has passed. */
export function eventHasEnded(event: Pick<EventStatusInput, "endsAt">, now: number): boolean {
  return event.endsAt !== undefined && now > event.endsAt;
}

/**
 * The single sentence at the top of the event home.
 *
 * The distinction that matters to a host on the night is between "guests can
 * get in" and "guests can upload" — `scheduled` is the first without the
 * second, and it is the state a well-organised host is in when the doors open.
 */
export function eventStatusLine(event: EventStatusInput, now: number): string {
  const copy = EVENT_STATE_COPY[event.state];

  if (event.state === "scheduled") {
    return now < event.startsAt
      ? `Starts ${formatRelative(event.startsAt, now)} — guests can join now, uploads open when you go live.`
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

export function guestsCanUpload(state: EventState): boolean {
  return acceptsUploads(state);
}

export function galleryIsVisible(state: EventState): boolean {
  return isViewableEventState(state);
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
