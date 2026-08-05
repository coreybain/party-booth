import { z } from "zod";

import { createStateMachine, type TransitionTable } from "./state-machine";

/**
 * Event lifecycle.
 *
 * - `draft` — being set up. Not joinable, invisible to guests.
 * - `scheduled` — set up and dated. **Joinable**, so printed QR signage works
 *   before the doors open. Uploads normally wait until it goes live, but an
 *   event may carry an explicit pre-event upload opening time.
 * - `live` — the party. Always accepts uploads.
 * - `paused` — the host hit pause. Guests keep their membership and the gallery,
 *   uploads are refused.
 * - `archived` — over. Read-only gallery, slideshow still presentable.
 * - `deletionScheduled` — queued for removal. Access revoked; the purge job is
 *   post-launch (P1).
 */
export const EVENT_STATES = [
  "draft",
  "scheduled",
  "live",
  "paused",
  "archived",
  "deletionScheduled",
] as const;

export type EventState = (typeof EVENT_STATES)[number];

export const eventStateSchema = z.enum(EVENT_STATES);

const EVENT_TRANSITIONS: TransitionTable<EventState> = {
  draft: ["scheduled", "live", "archived", "deletionScheduled"],
  scheduled: ["draft", "live", "archived", "deletionScheduled"],
  live: ["paused", "archived", "deletionScheduled"],
  paused: ["live", "archived", "deletionScheduled"],
  // Re-opening a finished party is a real thing (the after-party); allow it.
  archived: ["live", "deletionScheduled"],
  // Admin "restore deletion" puts the event back where it can do least harm.
  deletionScheduled: ["archived"],
};

export const eventStateMachine = createStateMachine("Event", EVENT_STATES, EVENT_TRANSITIONS);

/**
 * States in which a six-digit code / QR token resolves to a joinable event.
 * Codes must be unique **among these** — see `codes.ts`.
 */
export const JOINABLE_EVENT_STATES = [
  "scheduled",
  "live",
  "paused",
] as const satisfies readonly EventState[];

/** The states that accept uploads without consulting an event-specific schedule. */
export const UPLOADABLE_EVENT_STATES = ["live"] as const satisfies readonly EventState[];

/** States in which the approved gallery and slideshow render. */
export const VIEWABLE_EVENT_STATES = [
  "live",
  "paused",
  "archived",
] as const satisfies readonly EventState[];

/** States in which host settings may still be edited. */
export const EDITABLE_EVENT_STATES = [
  "draft",
  "scheduled",
  "live",
  "paused",
] as const satisfies readonly EventState[];

export function isJoinableEventState(state: EventState): boolean {
  return (JOINABLE_EVENT_STATES as readonly EventState[]).includes(state);
}

export function acceptsUploads(state: EventState): boolean {
  return (UPLOADABLE_EVENT_STATES as readonly EventState[]).includes(state);
}

export interface EventUploadWindow {
  readonly state: EventState;
  /** Optional opening time for pre-event uploads while still `scheduled`. */
  readonly uploadStartsAt?: number | undefined;
}

/**
 * Whether this event accepts a new upload at this instant.
 *
 * `live` remains an unconditional open door. A pre-event opening applies only
 * while scheduled, so pausing or archiving the party always closes it again.
 */
export function eventAcceptsUploads(event: EventUploadWindow, now: number): boolean {
  if (acceptsUploads(event.state)) return true;
  return (
    event.state === "scheduled" && event.uploadStartsAt !== undefined && now >= event.uploadStartsAt
  );
}

export function isViewableEventState(state: EventState): boolean {
  return (VIEWABLE_EVENT_STATES as readonly EventState[]).includes(state);
}

export function isEditableEventState(state: EventState): boolean {
  return (EDITABLE_EVENT_STATES as readonly EventState[]).includes(state);
}

/**
 * States a **host** may move an event into from the console.
 *
 * `deletionScheduled` is deliberately absent: it is reserved for the deletion
 * lifecycle (admin console, Sprint 5) and reaching it must go through the code
 * that also writes a `deletionJobs` row, not through a generic state setter.
 */
export const HOST_SETTABLE_EVENT_STATES = [
  "draft",
  "scheduled",
  "live",
  "paused",
  "archived",
] as const satisfies readonly EventState[];

export type HostSettableEventState = (typeof HOST_SETTABLE_EVENT_STATES)[number];

export const hostSettableEventStateSchema = z.enum(HOST_SETTABLE_EVENT_STATES);

export function isHostSettableEventState(state: EventState): state is HostSettableEventState {
  return (HOST_SETTABLE_EVENT_STATES as readonly EventState[]).includes(state);
}

/* -------------------------------------------------------------------------- */
/* Join window                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The schedule half of "is this event joinable?". The state machine is the
 * other half, and both have to pass.
 *
 * The bounds are wide on purpose. A join window that is too tight is a support
 * call at the door; one that is unbounded means a QR photographed at a party
 * still works two years later.
 */
export const JOIN_WINDOW = {
  /**
   * How far ahead of `startsAt` the code starts working. PLAN.md wants printed
   * signage usable before the doors open, and hosts set up days in advance;
   * thirty days covers that without leaving next year's party open today.
   */
  opensBeforeStartMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * Grace after `endsAt`. The last guest through the door is always after the
   * official end time, and a host who forgets to archive should not lock people
   * out mid-party — twelve hours covers a night that runs long.
   */
  closesAfterEndMs: 12 * 60 * 60 * 1000,
} as const;

export interface EventScheduleWindow {
  startsAt: number;
  /** Open-ended when absent: only the host archiving the event closes it. */
  endsAt?: number | undefined;
}

export type JoinWindowStatus = "open" | "tooEarly" | "closed";

export function joinWindowStatus(schedule: EventScheduleWindow, now: number): JoinWindowStatus {
  if (now < schedule.startsAt - JOIN_WINDOW.opensBeforeStartMs) return "tooEarly";
  if (schedule.endsAt !== undefined && now > schedule.endsAt + JOIN_WINDOW.closesAfterEndMs) {
    return "closed";
  }
  return "open";
}

export function isWithinJoinWindow(schedule: EventScheduleWindow, now: number): boolean {
  return joinWindowStatus(schedule, now) === "open";
}

/**
 * The whole joinability question in one call: state **and** schedule.
 *
 * Returns a reason so the caller can put it in the audit log. It must not put
 * it in the response — see `JOIN_REJECTED_MESSAGE` in `join.ts`.
 */
export function eventJoinability(
  event: { state: EventState } & EventScheduleWindow,
  now: number,
): { joinable: true } | { joinable: false; reason: "eventNotJoinable" | "outsideWindow" } {
  if (!isJoinableEventState(event.state)) return { joinable: false, reason: "eventNotJoinable" };
  if (!isWithinJoinWindow(event, now)) return { joinable: false, reason: "outsideWindow" };
  return { joinable: true };
}

/* -------------------------------------------------------------------------- */
/* Moderation mode                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `ai` is defined here so the schema and the union never need a migration, but
 * it is **not selectable at launch** — see {@link LAUNCH_MODERATION_MODES}.
 * P1 turns it on.
 */
export const MODERATION_MODES = ["manual", "automatic", "ai"] as const;

export type ModerationMode = (typeof MODERATION_MODES)[number];

export const moderationModeSchema = z.enum(MODERATION_MODES);

export const LAUNCH_MODERATION_MODES = [
  "manual",
  "automatic",
] as const satisfies readonly ModerationMode[];

export type LaunchModerationMode = (typeof LAUNCH_MODERATION_MODES)[number];

/** Modes an organiser may actually pick today. Reject anything else at the API edge. */
export const launchModerationModeSchema = z.enum(LAUNCH_MODERATION_MODES);

export function isLaunchModerationMode(mode: ModerationMode): mode is LaunchModerationMode {
  return (LAUNCH_MODERATION_MODES as readonly ModerationMode[]).includes(mode);
}
