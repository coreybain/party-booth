import { describe, expect, it } from "vitest";

import type { EventSummary } from "./convex-api";
import {
  buildCreateEventInput,
  buildUpdateEventInput,
  defaultEventFormValues,
  eventToFormValues,
  hasEventChanges,
  type EventFormValues,
} from "./event-form";

/**
 * The form model is the only thing between what a host types and what Convex
 * stores, so the tests below are about the two ways that goes wrong silently:
 * a schedule an hour out, and an update payload that asks for a permission the
 * host does not need.
 */

const VALUES: EventFormValues = {
  name: "Corey's 40th",
  startsAtLocal: "2026-08-05T20:00",
  endsAtLocal: "2026-08-06T01:00",
  timeZone: "Europe/London",
  moderationMode: "manual",
  accentColor: "",
  allowLibraryImport: true,
  initialState: "scheduled",
  preUploadTiming: "oneHour",
  uploadStartsAtLocal: "2026-08-05T19:00",
};

describe("buildCreateEventInput", () => {
  it("resolves the wall clock in the chosen zone", () => {
    const built = buildCreateEventInput(VALUES);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // 20:00 BST is 19:00 UTC.
    expect(built.input.schedule.startsAt).toBe(Date.UTC(2026, 7, 5, 19, 0));
    expect(built.input.schedule.endsAt).toBe(Date.UTC(2026, 7, 6, 0, 0));
    expect(built.input.schedule.timeZone).toBe("Europe/London");
  });

  it("trims the name and rejects an empty one", () => {
    const built = buildCreateEventInput({ ...VALUES, name: "  Corey's 40th  " });
    expect(built.ok && built.input.name).toBe("Corey's 40th");

    const empty = buildCreateEventInput({ ...VALUES, name: "   " });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.errors.name).toBeDefined();
  });

  it("treats an empty end time as open-ended rather than as zero", () => {
    const built = buildCreateEventInput({ ...VALUES, endsAtLocal: "" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.schedule.endsAt).toBeUndefined();
  });

  it("surfaces the contract's end-before-start rule on the end field", () => {
    const built = buildCreateEventInput({
      ...VALUES,
      startsAtLocal: "2026-08-05T20:00",
      endsAtLocal: "2026-08-05T18:00",
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.endsAtLocal).toBeDefined();
    expect(built.errors.startsAtLocal).toBeUndefined();
  });

  it("reports a missing start on the start field", () => {
    const built = buildCreateEventInput({ ...VALUES, startsAtLocal: "" });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.startsAtLocal).toBeDefined();
  });

  it("omits the accent colour when the host kept the default", () => {
    const built = buildCreateEventInput(VALUES);
    expect(built.ok && "accentColor" in built.input).toBe(false);
  });

  it("normalises a chosen accent colour to lower-case hex", () => {
    const built = buildCreateEventInput({ ...VALUES, accentColor: "#34D399" });
    expect(built.ok && built.input.accentColor).toBe("#34d399");
  });

  it("carries the starting state through", () => {
    expect(buildCreateEventInput({ ...VALUES, initialState: "draft" })).toMatchObject({
      ok: true,
      input: { initialState: "draft" },
    });
  });

  it("turns the pre-event presets into an absolute opening time", () => {
    const built = buildCreateEventInput({
      ...VALUES,
      initialState: "scheduledUploads",
      preUploadTiming: "fourHours",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.initialState).toBe("scheduled");
    expect(built.input.uploadStartsAt).toBe(Date.UTC(2026, 7, 5, 15, 0));
  });

  it("resolves and validates a specific pre-event opening in the event's zone", () => {
    const built = buildCreateEventInput({
      ...VALUES,
      initialState: "scheduledUploads",
      preUploadTiming: "custom",
      uploadStartsAtLocal: "2026-08-05T17:30",
    });
    expect(built.ok && built.input.uploadStartsAt).toBe(Date.UTC(2026, 7, 5, 16, 30));

    const late = buildCreateEventInput({
      ...VALUES,
      initialState: "scheduledUploads",
      preUploadTiming: "custom",
      uploadStartsAtLocal: "2026-08-05T20:30",
    });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.errors.uploadStartsAtLocal).toMatch(/before the event/i);
  });
});

describe("buildUpdateEventInput", () => {
  it("sends only what changed", () => {
    const built = buildUpdateEventInput("evt_1", { ...VALUES, name: "Corey's 41st" }, VALUES);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toEqual({ eventId: "evt_1", name: "Corey's 41st" });
    // The schedule is deliberately absent: including it would make Convex
    // demand `event.updateSchedule` for a rename.
    expect(built.input.schedule).toBeUndefined();
  });

  it("sends the whole schedule when any part of it moves", () => {
    const built = buildUpdateEventInput("evt_1", { ...VALUES, timeZone: "Europe/Paris" }, VALUES);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.schedule).toEqual({
      // 20:00 in Paris is 18:00 UTC in August.
      startsAt: Date.UTC(2026, 7, 5, 18, 0),
      endsAt: Date.UTC(2026, 7, 5, 23, 0),
      timeZone: "Europe/Paris",
    });
    expect(built.input.name).toBeUndefined();
  });

  it("sends nothing but the id when nothing changed", () => {
    const built = buildUpdateEventInput("evt_1", VALUES, VALUES);
    expect(built.ok && built.input).toEqual({ eventId: "evt_1" });
  });

  it("still validates the fields it does send", () => {
    const built = buildUpdateEventInput("evt_1", { ...VALUES, name: "" }, VALUES);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.name).toBeDefined();
  });
});

describe("hasEventChanges", () => {
  it("ignores the create-only starting state", () => {
    expect(hasEventChanges({ ...VALUES, initialState: "draft" }, VALUES)).toBe(false);
  });

  it("notices every field the update can carry", () => {
    expect(hasEventChanges({ ...VALUES, name: "x" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, startsAtLocal: "2026-08-05T21:00" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, endsAtLocal: "" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, timeZone: "UTC" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, moderationMode: "automatic" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, accentColor: "#34d399" }, VALUES)).toBe(true);
    expect(hasEventChanges({ ...VALUES, allowLibraryImport: false }, VALUES)).toBe(true);
  });
});

describe("eventToFormValues", () => {
  const summary: EventSummary = {
    id: "evt_1",
    name: "Corey's 40th",
    state: "live",
    moderationMode: "automatic",
    startsAt: Date.UTC(2026, 7, 5, 19, 0),
    endsAt: Date.UTC(2026, 7, 6, 0, 0),
    timeZone: "Europe/London",
    allowLibraryImport: false,
    publicGalleryEnabled: false,
    storageRegion: "pdx1",
    role: "owner",
    counts: { pending: 0, approved: 0, declined: 0, total: 0 },
  };

  it("renders the stored instants back into the event's own zone", () => {
    expect(eventToFormValues(summary)).toMatchObject({
      startsAtLocal: "2026-08-05T20:00",
      endsAtLocal: "2026-08-06T01:00",
      timeZone: "Europe/London",
      moderationMode: "automatic",
      allowLibraryImport: false,
    });
  });

  it("round-trips an unedited event to an empty update", () => {
    const values = eventToFormValues(summary);
    const built = buildUpdateEventInput(summary.id, values, values);
    expect(built.ok && built.input).toEqual({ eventId: summary.id });
  });

  it("falls back to the safe moderation mode for a mode not selectable at launch", () => {
    expect(eventToFormValues({ ...summary, moderationMode: "ai" }).moderationMode).toBe("manual");
  });

  it("leaves the end time empty for an open-ended event", () => {
    const open = { ...summary };
    delete (open as { endsAt?: number }).endsAt;
    expect(eventToFormValues(open).endsAtLocal).toBe("");
  });
});

describe("defaultEventFormValues", () => {
  it("proposes a whole hour in the future, not the current minute", () => {
    const values = defaultEventFormValues(Date.UTC(2026, 7, 5, 19, 43), "UTC");
    expect(values.startsAtLocal).toBe("2026-08-05T21:00");
    expect(values.endsAtLocal).toBe("2026-08-06T01:00");
  });

  it("defaults to the safest useful combination", () => {
    const values = defaultEventFormValues(Date.now(), "UTC");
    // Review each one, and a code that already works so the sign can be printed.
    expect(values.moderationMode).toBe("manual");
    expect(values.initialState).toBe("scheduled");
  });
});
