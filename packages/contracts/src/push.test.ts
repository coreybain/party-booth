import { describe, expect, it } from "vitest";

import {
  chunk,
  eventLifecyclePayload,
  parsePushPayload,
  pendingThresholdPayload,
  uploadStatusPayload,
  DEFAULT_PENDING_THRESHOLD,
  EXPO_PUSH_MAX_PAYLOAD_BYTES,
  EXPO_PUSH_RECEIPTS_ENDPOINT,
  EXPO_PUSH_RECEIPT_CHUNK_SIZE,
  EXPO_PUSH_SEND_CHUNK_SIZE,
  EXPO_PUSH_SEND_ENDPOINT,
  expoPushTokenSchema,
  fitsPushPayload,
  isExpoPushToken,
  isProjectCredentialError,
  isRetryablePushError,
  nextDeviceHealth,
  PUSH_PROJECT_CREDENTIAL_ERRORS,
  notificationPreferencesSchema,
  pendingThresholdOf,
  PUSH_CATEGORIES,
  PUSH_CATEGORY_COPY,
  PUSH_DEBOUNCE_MS,
  PUSH_FAILURE_LIMIT,
  PUSH_RECEIPT_DELAY_MS,
  shouldNotifyDebounced,
  shouldNotifyPendingThreshold,
  shouldNotifyUploadQueue,
  shouldPruneToken,
  truncateToPayload,
  UPLOAD_QUEUE_FAILED_MARK,
  wantsPushCategory,
  type ExpoPushMessage,
} from "./push";

describe("categories and preferences", () => {
  it("has copy for every category", () => {
    for (const category of PUSH_CATEGORIES) {
      expect(PUSH_CATEGORY_COPY[category].title.length).toBeGreaterThan(0);
      expect(PUSH_CATEGORY_COPY[category].description.length).toBeGreaterThan(0);
      expect(PUSH_DEBOUNCE_MS[category]).toBeGreaterThan(0);
    }
  });

  it("treats absent preferences as everything on", () => {
    for (const category of PUSH_CATEGORIES) {
      expect(wantsPushCategory(undefined, category)).toBe(true);
      expect(wantsPushCategory({}, category)).toBe(true);
      expect(wantsPushCategory({ optOut: [] }, category)).toBe(true);
    }
  });

  it("respects an opt-out, and only for the category named", () => {
    const prefs = { optOut: ["eventLifecycle"] as const };
    expect(wantsPushCategory(prefs, "eventLifecycle")).toBe(false);
    expect(wantsPushCategory(prefs, "uploadStatus")).toBe(true);
  });

  it("falls back to the PLAN default threshold and clamps nonsense", () => {
    expect(pendingThresholdOf(undefined)).toBe(DEFAULT_PENDING_THRESHOLD);
    expect(pendingThresholdOf({})).toBe(DEFAULT_PENDING_THRESHOLD);
    expect(pendingThresholdOf({ pendingThreshold: 12 })).toBe(12);
    expect(pendingThresholdOf({ pendingThreshold: 0 })).toBe(1);
    expect(pendingThresholdOf({ pendingThreshold: 9999 })).toBe(100);
    expect(pendingThresholdOf({ pendingThreshold: Number.NaN })).toBe(DEFAULT_PENDING_THRESHOLD);
  });

  it("parses a preferences payload", () => {
    const parsed = notificationPreferencesSchema.parse({ optOut: ["uploadStatus"] });
    expect(parsed.optOut).toEqual(["uploadStatus"]);
    expect(parsed.pendingThreshold).toBeUndefined();
    expect(notificationPreferencesSchema.safeParse({ optOut: ["nope"] }).success).toBe(false);
    expect(notificationPreferencesSchema.safeParse({ pendingThreshold: 0 }).success).toBe(false);
  });
});

describe("the pending-threshold debounce", () => {
  const threshold = DEFAULT_PENDING_THRESHOLD;

  it("stays quiet below the line and clears the memory there", () => {
    const decision = shouldNotifyPendingThreshold({
      pending: threshold - 1,
      threshold,
      state: { lastSentAt: 1_000 },
      now: 2_000,
    });
    expect(decision).toEqual({ notify: false, reason: "belowThreshold", clear: true });
  });

  it("fires the first time the line is crossed", () => {
    expect(
      shouldNotifyPendingThreshold({ pending: threshold, threshold, state: undefined, now: 1_000 }),
    ).toEqual({ notify: true });
  });

  it("sends one ping for a burst", () => {
    // Thirty photographs in the same second are one event in a host's life.
    let state: { lastSentAt?: number } | undefined;
    let pings = 0;
    for (let pending = threshold; pending < threshold + 30; pending += 1) {
      const decision = shouldNotifyPendingThreshold({ pending, threshold, state, now: 1_000 });
      if (decision.notify) {
        pings += 1;
        state = { lastSentAt: 1_000 };
      }
    }
    expect(pings).toBe(1);
  });

  it("fires again once the window has passed", () => {
    const state = { lastSentAt: 1_000 };
    const window = PUSH_DEBOUNCE_MS.hostPendingThreshold;
    expect(
      shouldNotifyPendingThreshold({
        pending: threshold,
        threshold,
        state,
        now: 1_000 + window - 1,
      }).notify,
    ).toBe(false);
    expect(
      shouldNotifyPendingThreshold({ pending: threshold, threshold, state, now: 1_000 + window })
        .notify,
    ).toBe(true);
  });

  it("honours a caller-supplied window", () => {
    expect(
      shouldNotifyPendingThreshold({
        pending: threshold,
        threshold,
        state: { lastSentAt: 0 },
        now: 500,
        debounceMs: 100,
      }).notify,
    ).toBe(true);
  });
});

describe("the plain debounce", () => {
  it("fires with no memory and then holds for the window", () => {
    expect(shouldNotifyDebounced("eventLifecycle", undefined, 0)).toBe(true);
    expect(shouldNotifyDebounced("eventLifecycle", { lastSentAt: 0 }, 1)).toBe(false);
    expect(
      shouldNotifyDebounced("eventLifecycle", { lastSentAt: 0 }, PUSH_DEBOUNCE_MS.eventLifecycle),
    ).toBe(true);
  });
});

describe("the upload-queue pairing", () => {
  it("announces a failure once", () => {
    expect(shouldNotifyUploadQueue("failed", undefined)).toBe(true);
    expect(shouldNotifyUploadQueue("failed", { lastValue: UPLOAD_QUEUE_FAILED_MARK })).toBe(false);
  });

  it("announces a recovery only to somebody who was told to worry", () => {
    // "Your photo sent" is noise on its own and reassurance after "it did not".
    expect(shouldNotifyUploadQueue("recovered", undefined)).toBe(false);
    expect(shouldNotifyUploadQueue("recovered", { lastSentAt: 1 })).toBe(false);
    expect(shouldNotifyUploadQueue("recovered", { lastValue: UPLOAD_QUEUE_FAILED_MARK })).toBe(
      true,
    );
  });
});

describe("Expo push tokens", () => {
  it("accepts both spellings the SDK emits", () => {
    expect(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc-123_XYZ]")).toBe(true);
  });

  it("refuses everything a broken registration actually produces", () => {
    for (const bad of [
      "",
      "   ",
      "not-a-token",
      "ExponentPushToken[]",
      "ExponentPushToken[has space]",
      "fcm:dGhpcyBpcyBhbiBGQ00gdG9rZW4",
      "ExponentPushToken[abc",
    ]) {
      expect(isExpoPushToken(bad), bad).toBe(false);
      expect(expoPushTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("trims before validating", () => {
    expect(expoPushTokenSchema.parse("  ExponentPushToken[abc]  ")).toBe("ExponentPushToken[abc]");
  });
});

describe("the Expo service contract", () => {
  it("names the documented endpoints and limits", () => {
    // Transcribed from the Expo docs; a change here is a change to what the
    // adapter is built against, and should be a deliberate edit.
    expect(EXPO_PUSH_SEND_ENDPOINT).toBe("https://exp.host/--/api/v2/push/send");
    expect(EXPO_PUSH_RECEIPTS_ENDPOINT).toBe("https://exp.host/--/api/v2/push/getReceipts");
    expect(EXPO_PUSH_SEND_CHUNK_SIZE).toBe(100);
    expect(EXPO_PUSH_RECEIPT_CHUNK_SIZE).toBe(1000);
    expect(EXPO_PUSH_MAX_PAYLOAD_BYTES).toBe(4096);
    expect(PUSH_RECEIPT_DELAY_MS).toBe(15 * 60_000);
  });

  it("prunes a token only for DeviceNotRegistered", () => {
    expect(shouldPruneToken("DeviceNotRegistered")).toBe(true);
    // The rest describe the project's credentials or the message, not the phone.
    // Pruning on `InvalidCredentials` would empty the table the day somebody
    // rotates an APNs key.
    for (const code of [
      "MessageTooBig",
      "MessageRateExceeded",
      "MismatchSenderId",
      "InvalidCredentials",
      "InvalidProviderToken",
      undefined,
    ]) {
      expect(shouldPruneToken(code), String(code)).toBe(false);
    }
  });

  it("treats only a rate limit as retryable", () => {
    expect(isRetryablePushError("MessageRateExceeded")).toBe(true);
    expect(isRetryablePushError("DeviceNotRegistered")).toBe(false);
    expect(isRetryablePushError(undefined)).toBe(false);
  });

  it("chunks into request-sized batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(
      chunk(
        Array.from({ length: 250 }, (_, i) => i),
        100,
      ).map((c) => c.length),
    ).toEqual([100, 100, 50]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it("truncates a message that would not fit rather than dropping it", () => {
    const message: ExpoPushMessage = {
      to: "ExponentPushToken[abc]",
      title: "Title",
      body: "x".repeat(EXPO_PUSH_MAX_PAYLOAD_BYTES * 2),
    };
    expect(fitsPushPayload(message)).toBe(false);

    const trimmed = truncateToPayload(message);
    expect(fitsPushPayload(trimmed)).toBe(true);
    // The title carries the meaning; the body is context.
    expect(trimmed.title).toBe("Title");
    expect(trimmed.body.length).toBeGreaterThan(0);

    // A message that already fits is returned untouched.
    const small: ExpoPushMessage = { to: "ExponentPushToken[abc]", title: "a", body: "b" };
    expect(truncateToPayload(small)).toBe(small);
  });
});

describe("device health", () => {
  it("resets on success", () => {
    expect(nextDeviceHealth({ failureCount: 2, disabledAt: 5 }, { ok: true, now: 10 })).toEqual({
      failureCount: 0,
      disabledAt: undefined,
    });
  });

  it("kills a token outright on DeviceNotRegistered", () => {
    const next = nextDeviceHealth(
      { failureCount: 0 },
      { ok: false, errorCode: "DeviceNotRegistered", now: 10 },
    );
    expect(next.disabledAt).toBe(10);
  });

  it("does not blame the device for a project-level rate limit", () => {
    const next = nextDeviceHealth(
      { failureCount: 1 },
      { ok: false, errorCode: "MessageRateExceeded", now: 10 },
    );
    expect(next).toEqual({ failureCount: 1, disabledAt: undefined });
  });

  /**
   * A revoked APNs key fails for every device at once. Counting it would disable
   * the whole table on the third send — the outcome `shouldPruneToken` is narrow
   * to avoid, reached slowly instead of immediately.
   */
  it("does not blame the device for the project's credentials", () => {
    for (const code of PUSH_PROJECT_CREDENTIAL_ERRORS) {
      expect(isProjectCredentialError(code), code).toBe(true);
      let state: { failureCount: number; disabledAt: number | undefined } = {
        failureCount: 0,
        disabledAt: undefined,
      };
      for (let index = 0; index < PUSH_FAILURE_LIMIT + 2; index += 1) {
        state = nextDeviceHealth(state, { ok: false, errorCode: code, now: 10 });
      }
      expect(state, code).toEqual({ failureCount: 0, disabledAt: undefined });
    }
  });

  it(`disables after ${PUSH_FAILURE_LIMIT} consecutive ordinary failures`, () => {
    let state: { failureCount: number; disabledAt: number | undefined } = {
      failureCount: 0,
      disabledAt: undefined,
    };
    for (let index = 0; index < PUSH_FAILURE_LIMIT - 1; index += 1) {
      state = nextDeviceHealth(state, { ok: false, errorCode: "MessageTooBig", now: 10 });
      expect(state.disabledAt).toBeUndefined();
    }
    state = nextDeviceHealth(state, { ok: false, errorCode: "MessageTooBig", now: 10 });
    expect(state.failureCount).toBe(PUSH_FAILURE_LIMIT);
    expect(state.disabledAt).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* The routing payload                                                        */
/* -------------------------------------------------------------------------- */

describe("the routing payload", () => {
  /**
   * The reason this module exists. The backend builds the bag and the app parses
   * it, and they used to be two hand-written restatements that had already begun
   * to drift. A round trip is the property that matters: whatever a builder
   * emits, the parser must recover.
   */
  it("round-trips every builder through the parser", () => {
    expect(parsePushPayload(uploadStatusPayload("evt_1", "cap_1", "failed"))).toEqual({
      kind: "uploadStatus",
      eventId: "evt_1",
      transition: "failed",
      captureId: "cap_1",
    });

    expect(parsePushPayload(eventLifecyclePayload("evt_2", "closed"))).toEqual({
      kind: "eventLifecycle",
      eventId: "evt_2",
      transition: "closed",
      captureId: null,
    });

    expect(parsePushPayload(pendingThresholdPayload("evt_3"))).toEqual({
      kind: "hostPendingThreshold",
      eventId: "evt_3",
      transition: null,
      captureId: null,
    });
  });

  it("emits a string map, because that is all Expo carries", () => {
    for (const payload of [
      uploadStatusPayload("evt_1", "cap_1", "recovered"),
      eventLifecyclePayload("evt_1", "opened"),
      pendingThresholdPayload("evt_1"),
    ]) {
      for (const value of Object.values(payload)) expect(typeof value).toBe("string");
    }
  });

  it("only ever emits a kind that is a real category", () => {
    for (const payload of [
      uploadStatusPayload("e", "c", "failed"),
      eventLifecyclePayload("e", "opened"),
      pendingThresholdPayload("e"),
    ]) {
      expect(PUSH_CATEGORIES).toContain(payload.kind);
    }
  });

  it("refuses anything that is not one of ours", () => {
    for (const junk of [
      null,
      undefined,
      42,
      "hostPendingThreshold",
      {},
      { kind: "" },
      { kind: "somethingNewer" },
      { eventId: "evt_1" },
    ]) {
      expect(parsePushPayload(junk)).toBeNull();
    }
  });

  it("tolerates a payload from a deployment this build predates", () => {
    // Extra keys are ignored and absent optional ones are null, so a newer
    // server never turns a tap into a crash.
    expect(
      parsePushPayload({ kind: "eventLifecycle", eventId: "evt_1", venue: "kitchen" }),
    ).toEqual({ kind: "eventLifecycle", eventId: "evt_1", transition: null, captureId: null });
  });
});
