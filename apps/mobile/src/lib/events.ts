/**
 * How the app talks *about* an event: what its state means for a guest, and when
 * the party is, in the party's own time zone.
 *
 * No policy is decided here. Which states are joinable, which accept uploads and
 * where the join window sits all come from `@partybooth/contracts/events` — the same
 * functions Convex runs. What this module adds is the sentence a guest reads, and the
 * ordering/selection helpers the event switcher needs.
 *
 * No React Native imports, so it is unit-tested in plain Node.
 */

import {
  acceptsUploads,
  isJoinableEventState,
  isViewableEventState,
  joinWindowStatus,
  type EventState,
} from "@partybooth/contracts/events";

import type { EventId, EventSummary } from "./api";

/* -------------------------------------------------------------------------- */
/* State, in words                                                            */
/* -------------------------------------------------------------------------- */

/** Which colour token the badge should use. The screen maps this to `theme`. */
export type EventTone = "live" | "waiting" | "resting" | "closed";

export interface EventStateDescription {
  /** Two or three words for a badge. */
  readonly label: string;
  /** One sentence for the guest: what they can do right now. */
  readonly detail: string;
  readonly tone: EventTone;
  /** Capture is accepted — the Camera tab has something to send to. */
  readonly acceptsUploads: boolean;
  /** The approved gallery renders. */
  readonly viewable: boolean;
}

const STATE_DESCRIPTIONS: Record<
  EventState,
  Omit<EventStateDescription, "acceptsUploads" | "viewable">
> = {
  draft: {
    label: "Not set up",
    detail: "The host is still setting this party up. Nothing can be sent yet.",
    tone: "resting",
  },
  scheduled: {
    label: "Not open yet",
    detail: "You're in. The camera unlocks when the host opens the party.",
    tone: "waiting",
  },
  live: {
    label: "Live",
    detail: "The party is running — anything you capture goes straight to the host.",
    tone: "live",
  },
  paused: {
    label: "Paused",
    detail: "The host paused submissions. The gallery still works; the camera is on hold.",
    tone: "waiting",
  },
  archived: {
    label: "Finished",
    detail: "This party is over. The approved gallery stays here to look back at.",
    tone: "closed",
  },
  deletionScheduled: {
    label: "Being deleted",
    detail: "This party is queued for deletion and is no longer available.",
    tone: "closed",
  },
};

export function describeEventState(state: EventState): EventStateDescription {
  // `STATE_DESCRIPTIONS` is keyed by the contract's own union, so this is total;
  // `noUncheckedIndexedAccess` cannot see that through a `Record` lookup.
  const base = STATE_DESCRIPTIONS[state];
  return {
    ...base,
    acceptsUploads: acceptsUploads(state),
    viewable: isViewableEventState(state),
  };
}

/** Re-exported so screens ask one module rather than two. */
export { acceptsUploads, isJoinableEventState, isViewableEventState };

/* -------------------------------------------------------------------------- */
/* Schedule, in words                                                         */
/* -------------------------------------------------------------------------- */

export interface EventSchedule {
  readonly startsAt: number;
  readonly endsAt?: number | undefined;
  readonly timeZone: string;
}

/**
 * Format an instant in the *event's* time zone.
 *
 * A party has one clock and it is the host's, not the phone's: a guest who flew in
 * yesterday must not be told the doors open at 3am. `timeZone` is therefore always
 * passed explicitly.
 *
 * Hermes ships a partial `Intl`, and a stored time zone is host input that reaches
 * this function unverified, so an unsupported or malformed zone throws `RangeError`.
 * That must never blank out a screen — the fallback formats in the device's own zone
 * and says so, which is wrong-but-legible rather than crashed.
 */
export function formatEventDateTime(
  at: number,
  timeZone: string,
): { readonly text: string; readonly inEventTimeZone: boolean } {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return {
      text: new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(at)),
      inEventTimeZone: true,
    };
  } catch {
    return {
      text: new Intl.DateTimeFormat(undefined, options).format(new Date(at)),
      inEventTimeZone: false,
    };
  }
}

/**
 * The line under an event's name: when it starts, or that it is running now.
 *
 * `now` is a parameter rather than a `Date.now()` call so the copy is deterministic
 * in tests and can be driven from a ticking clock in a screen.
 */
export function describeSchedule(schedule: EventSchedule, now: number): string {
  const start = formatEventDateTime(schedule.startsAt, schedule.timeZone);
  const suffix = start.inEventTimeZone ? "" : " (your time)";

  if (now < schedule.startsAt) return `Starts ${start.text}${suffix}`;
  if (schedule.endsAt !== undefined && now > schedule.endsAt) {
    const end = formatEventDateTime(schedule.endsAt, schedule.timeZone);
    return `Ended ${end.text}${suffix}`;
  }
  return `Started ${start.text}${suffix}`;
}

/**
 * Why a code that resolved to a real event still will not let you in *yet*.
 *
 * Returns `null` when the schedule is no obstacle. This is only ever shown for an
 * event the caller has already been told about — it is never used to explain a
 * rejected join, because a rejection carries no reason by design.
 */
export function describeJoinWindow(schedule: EventSchedule, now: number): string | null {
  const status = joinWindowStatus(schedule, now);
  if (status === "open") return null;
  if (status === "tooEarly") {
    const start = formatEventDateTime(schedule.startsAt, schedule.timeZone);
    return `This invite starts working closer to the party — it begins ${start.text}.`;
  }
  return "This party has finished, so its invite has closed.";
}

/* -------------------------------------------------------------------------- */
/* Choosing between events                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Newest party first.
 *
 * `events.myEvents` already sorts server-side; re-sorting here means the switcher
 * does not silently depend on that, and an optimistic local insert lands in the right
 * place. Ties break on name so the order never flickers between renders.
 */
export function sortEvents(events: readonly EventSummary[]): EventSummary[] {
  return [...events].sort((a, b) => b.startsAt - a.startsAt || a.name.localeCompare(b.name));
}

/**
 * Which event the shell should act on.
 *
 * `events.activeEvent` is authoritative — it is per-user server state, so the phone
 * and the laptop agree — but it is a separate subscription that can arrive a beat
 * after the list. Resolving against the list by id keeps the switcher's highlight and
 * the header's title from disagreeing during that beat, and falls back to the newest
 * event so a fresh sign-in is never pointed at nothing.
 */
export function resolveActiveEvent(
  events: readonly EventSummary[],
  activeEventId: EventId | null | undefined,
): EventSummary | null {
  const sorted = sortEvents(events);
  if (activeEventId !== null && activeEventId !== undefined) {
    const match = sorted.find((event) => event.id === activeEventId);
    if (match) return match;
  }
  return sorted[0] ?? null;
}
