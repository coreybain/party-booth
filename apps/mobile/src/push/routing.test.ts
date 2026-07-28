/**
 * The routing table, as a table.
 *
 * Every row here corresponds to a `data` bag written by
 * `packages/backend/convex/lib/notifications.ts`. If that file changes what it
 * sends, these are the assertions that should fail — which is the whole reason
 * the payload shape is restated in `routing.ts` rather than inferred at the call
 * site.
 */

import { describe, expect, it } from "vitest";

import { parsePushData, routeForPush } from "./routing";

describe("routeForPush", () => {
  it.each([
    [
      "an upload that failed",
      { kind: "uploadStatus", transition: "failed", eventId: "ev1", captureId: "cap1" },
      { path: "/photos", eventId: "ev1" },
    ],
    [
      "an upload that recovered",
      { kind: "uploadStatus", transition: "recovered", eventId: "ev1", captureId: "cap1" },
      { path: "/photos", eventId: "ev1" },
    ],
    [
      "a party opening",
      { kind: "eventLifecycle", transition: "opened", eventId: "ev2" },
      { path: "/camera", eventId: "ev2" },
    ],
    [
      "a party wrapping up",
      { kind: "eventLifecycle", transition: "closed", eventId: "ev2" },
      { path: "/photos", eventId: "ev2" },
    ],
    [
      "a host's queue building up",
      { kind: "hostPendingThreshold", eventId: "ev3" },
      { path: "/host", eventId: "ev3" },
    ],
  ])("sends %s to the right screen", (_name, data, expected) => {
    expect(routeForPush(data)).toEqual(expected);
  });

  it("carries the event id so the shell can switch party before it navigates", () => {
    // The Host tab renders whatever the active event is. A host with two parties
    // told that *one* of them has a queue must not land on the other one's.
    expect(routeForPush({ kind: "hostPendingThreshold", eventId: "ev9" })?.eventId).toBe("ev9");
  });

  it.each([
    ["nothing at all", undefined],
    ["null", null],
    ["a string", "hostPendingThreshold"],
    ["an empty bag", {}],
    ["a kind this build has never heard of", { kind: "somethingNewer", eventId: "ev1" }],
  ])("ignores %s rather than guessing", (_name, data) => {
    expect(routeForPush(data)).toBeNull();
  });

  it("still routes a notification that names no event", () => {
    // Nothing sends one today, but a payload that lost its `eventId` in transit
    // should open the right *screen* rather than nothing at all.
    expect(routeForPush({ kind: "uploadStatus" })).toEqual({ path: "/photos", eventId: null });
  });

  it("treats an unknown lifecycle transition as an opening", () => {
    // `opened` is the only one that reaches a guest with something to do about
    // it, so it is the safe default for a value from a newer server.
    expect(routeForPush({ kind: "eventLifecycle", transition: "reopened", eventId: "e" })).toEqual({
      path: "/camera",
      eventId: "e",
    });
  });
});

describe("parsePushData", () => {
  it("keeps the capture id, which is how an upload ping names its subject", () => {
    expect(
      parsePushData({ kind: "uploadStatus", eventId: "e", captureId: "cap-42" })?.captureId,
    ).toBe("cap-42");
  });

  it("reads a missing or non-string field as absent rather than throwing", () => {
    expect(parsePushData({ kind: "uploadStatus", eventId: 12, captureId: "" })).toEqual({
      kind: "uploadStatus",
      eventId: null,
      transition: null,
      captureId: null,
    });
  });
});
