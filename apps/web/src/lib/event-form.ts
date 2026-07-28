/**
 * The event form's model: wall-clock strings in, contract-shaped input out.
 *
 * Kept free of React so it can be unit-tested, and kept *thin* on purpose —
 * every rule it enforces is `createEventInputSchema` / `updateEventInputSchema`
 * from `@partybooth/contracts`, the same schemas Convex parses with. The only
 * thing this module decides on its own is how a `datetime-local` field plus a
 * time-zone name become the epoch milliseconds the backend stores, which is a
 * presentation concern the contract has no opinion about.
 */

import {
  createEventInputSchema,
  updateEventInputSchema,
  type LaunchModerationMode,
} from "./contracts";
import { timestampToZonedInput, zonedInputToTimestamp } from "./datetime";
import type { EventSummary } from "./convex-api";

export interface EventFormValues {
  readonly name: string;
  /** `datetime-local` value, read in {@link EventFormValues.timeZone}. */
  readonly startsAtLocal: string;
  /** Empty means open-ended: only the host archiving the event closes it. */
  readonly endsAtLocal: string;
  readonly timeZone: string;
  readonly moderationMode: LaunchModerationMode;
  /** `#rrggbb`, or empty for the app's own accent. */
  readonly accentColor: string;
  readonly allowLibraryImport: boolean;
  /** Create only. `scheduled` makes the code and QR work immediately. */
  readonly initialState: "draft" | "scheduled";
}

export type EventFormField = keyof EventFormValues;
export type EventFormErrors = Partial<Record<EventFormField, string>>;

export interface EventScheduleInput {
  startsAt: number;
  endsAt?: number;
  timeZone: string;
}

export interface CreateEventInput {
  name: string;
  schedule: EventScheduleInput;
  moderationMode: LaunchModerationMode;
  accentColor?: string;
  allowLibraryImport: boolean;
  initialState: "draft" | "scheduled";
}

/** Only the fields that actually changed, so a co-host's schedule-only edit is not refused for the settings it did not send. */
export type UpdateEventInput = {
  eventId: string;
} & Partial<Omit<CreateEventInput, "initialState">>;

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** Round up to the next whole hour — nobody schedules a party for 19:43. */
function nextHour(now: number): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime() + 60 * 60 * 1000;
}

/**
 * A sensible blank form: this evening, four hours long, in the host's own zone.
 *
 * `timeZone` is a parameter rather than read from `Intl` here because the
 * browser's zone is not knowable during server rendering, and guessing one then
 * correcting it on the client is a hydration mismatch.
 */
export function defaultEventFormValues(now: number, timeZone: string): EventFormValues {
  const startsAt = nextHour(now) + 60 * 60 * 1000;
  return {
    name: "",
    startsAtLocal: timestampToZonedInput(startsAt, timeZone),
    endsAtLocal: timestampToZonedInput(startsAt + 4 * 60 * 60 * 1000, timeZone),
    timeZone,
    moderationMode: "manual",
    accentColor: "",
    allowLibraryImport: true,
    initialState: "scheduled",
  };
}

/** An existing event, as the form sees it. */
export function eventToFormValues(event: EventSummary): EventFormValues {
  return {
    name: event.name,
    startsAtLocal: timestampToZonedInput(event.startsAt, event.timeZone),
    endsAtLocal:
      event.endsAt === undefined ? "" : timestampToZonedInput(event.endsAt, event.timeZone),
    timeZone: event.timeZone,
    // `ai` is defined in the contract but not selectable at launch; an event
    // that somehow carries it falls back to the safe mode rather than crashing
    // a radio group.
    moderationMode: event.moderationMode === "automatic" ? "automatic" : "manual",
    accentColor: event.accentColor ?? "",
    allowLibraryImport: event.allowLibraryImport,
    initialState: event.state === "draft" ? "draft" : "scheduled",
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type FormResult<T> = { ok: true; input: T } | { ok: false; errors: EventFormErrors };

/** Map a contract-schema path onto the field the host is looking at. */
function fieldFor(path: readonly PropertyKey[]): EventFormField {
  const [head, tail] = path;
  if (head === "schedule") {
    if (tail === "endsAt") return "endsAtLocal";
    if (tail === "timeZone") return "timeZone";
    return "startsAtLocal";
  }
  switch (head) {
    case "name":
      return "name";
    case "moderationMode":
      return "moderationMode";
    case "accentColor":
      return "accentColor";
    case "allowLibraryImport":
      return "allowLibraryImport";
    case "initialState":
      return "initialState";
    default:
      return "name";
  }
}

/**
 * Resolve the two wall-clock fields against the zone.
 *
 * The end-after-start rule is *not* checked here: `eventScheduleSchema` owns
 * it, and duplicating it would be a second place for it to change.
 */
function buildSchedule(
  values: EventFormValues,
): { ok: true; schedule: EventScheduleInput } | { ok: false; errors: EventFormErrors } {
  const errors: EventFormErrors = {};

  const startsAt = zonedInputToTimestamp(values.startsAtLocal, values.timeZone);
  if (startsAt === undefined) errors.startsAtLocal = "Pick a start date and time.";

  let endsAt: number | undefined;
  if (values.endsAtLocal.trim() !== "") {
    endsAt = zonedInputToTimestamp(values.endsAtLocal, values.timeZone);
    if (endsAt === undefined) errors.endsAtLocal = "That end time isn't a valid date and time.";
  }

  if (startsAt === undefined || Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    schedule: {
      startsAt,
      ...(endsAt === undefined ? {} : { endsAt }),
      timeZone: values.timeZone,
    },
  };
}

function collect(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const errors: EventFormErrors = {};
  for (const issue of issues) {
    const field = fieldFor(issue.path);
    errors[field] ??= issue.message;
  }
  return errors;
}

export function buildCreateEventInput(values: EventFormValues): FormResult<CreateEventInput> {
  const schedule = buildSchedule(values);
  if (!schedule.ok) return schedule;

  const parsed = createEventInputSchema.safeParse({
    name: values.name,
    schedule: schedule.schedule,
    moderationMode: values.moderationMode,
    ...(values.accentColor === "" ? {} : { accentColor: values.accentColor }),
    allowLibraryImport: values.allowLibraryImport,
    initialState: values.initialState,
  });
  if (!parsed.success) return { ok: false, errors: collect(parsed.error.issues) };

  const { data } = parsed;
  return {
    ok: true,
    input: {
      name: data.name,
      schedule: data.schedule,
      moderationMode: data.moderationMode,
      ...(data.accentColor === undefined ? {} : { accentColor: data.accentColor }),
      allowLibraryImport: data.allowLibraryImport,
      initialState: data.initialState,
    },
  };
}

/**
 * The update payload, reduced to what actually changed.
 *
 * The backend demands a *different capability* per group of fields — a co-host
 * may move the schedule but may not rename the party — and only demands one
 * when that group is present. Sending every field on every save would turn a
 * co-host's schedule edit into a permission error.
 */
export function buildUpdateEventInput(
  eventId: string,
  values: EventFormValues,
  original: EventFormValues,
): FormResult<UpdateEventInput> {
  const schedule = buildSchedule(values);
  if (!schedule.ok) return schedule;

  const scheduleChanged =
    values.startsAtLocal !== original.startsAtLocal ||
    values.endsAtLocal !== original.endsAtLocal ||
    values.timeZone !== original.timeZone;

  const candidate = {
    eventId,
    ...(values.name === original.name ? {} : { name: values.name }),
    ...(scheduleChanged ? { schedule: schedule.schedule } : {}),
    ...(values.moderationMode === original.moderationMode
      ? {}
      : { moderationMode: values.moderationMode }),
    ...(values.accentColor === original.accentColor || values.accentColor === ""
      ? {}
      : { accentColor: values.accentColor }),
    ...(values.allowLibraryImport === original.allowLibraryImport
      ? {}
      : { allowLibraryImport: values.allowLibraryImport }),
  };

  const parsed = updateEventInputSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: collect(parsed.error.issues) };

  return { ok: true, input: parsed.data as UpdateEventInput };
}

/** Is there anything to send? Saving an unchanged form should be a no-op. */
export function hasEventChanges(values: EventFormValues, original: EventFormValues): boolean {
  return (
    values.name !== original.name ||
    values.startsAtLocal !== original.startsAtLocal ||
    values.endsAtLocal !== original.endsAtLocal ||
    values.timeZone !== original.timeZone ||
    values.moderationMode !== original.moderationMode ||
    values.accentColor !== original.accentColor ||
    values.allowLibraryImport !== original.allowLibraryImport
  );
}

/**
 * The accent swatches offered in the form.
 *
 * A fixed palette rather than a colour input: these are the values that stay
 * legible as a 6 px stripe on a dark card and behind white text, and a host
 * choosing `#0b0b10` at 1 a.m. produces an event nobody can see.
 */
export const ACCENT_SWATCHES = [
  { value: "", label: "PartyBooth pink", swatch: "#ff4d8d" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#34d399", label: "Mint" },
  { value: "#38bdf8", label: "Sky" },
  { value: "#a78bfa", label: "Violet" },
  { value: "#fb7185", label: "Coral" },
] as const satisfies readonly { value: string; label: string; swatch?: string }[];
