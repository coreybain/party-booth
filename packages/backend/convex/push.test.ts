import {
  AUDIT_ACTIONS,
  DEFAULT_PENDING_THRESHOLD,
  PUSH_FAILURE_LIMIT,
} from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import {
  api,
  auditActions,
  clearFakePush,
  clearFakeStorage,
  internal,
  makeTest,
  pushRows,
  pushToken,
  runScheduled,
  seedEvent,
  seedMedia,
  seedMembership,
  seedPushDevice,
  seedUser,
  useFakePush,
  useFakeStorage,
  type T,
} from "./testing.helpers";

/**
 * Push notifications, end to end, with **no network and no credentials**.
 *
 * The whole point of `lib/push/` is that this suite can exist: the fake adapter
 * records what was asked of Expo and scripts the two answers that matter — a
 * refused ticket and a `DeviceNotRegistered` receipt — neither of which is
 * reachable against the real service without a real dead phone.
 */

describe("push device lifecycle", () => {
  let t: T;
  let userId: Id<"users">;

  beforeEach(async () => {
    t = makeTest();
    userId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
  });

  it("registers a token, and re-registering the same one refreshes rather than duplicates", async () => {
    const as = t.withIdentity({ subject: "guest" });
    const token = pushToken("aaaaaaaaaa");

    const first = await as.mutation(api.push.registerDevice, {
      expoPushToken: token,
      platform: "ios",
      deviceName: "Sam's iPhone",
    });
    expect(first.created).toBe(true);

    const second = await as.mutation(api.push.registerDevice, {
      expoPushToken: token,
      platform: "ios",
    });
    expect(second.created).toBe(false);
    expect(second.deviceId).toBe(first.deviceId);

    const devices = await t.run(async (ctx) => ctx.db.query("pushDevices").collect());
    expect(devices).toHaveLength(1);
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.pushDeviceRegistered);
  });

  it("refuses anything that is not an Expo push token", async () => {
    const as = t.withIdentity({ subject: "guest" });
    for (const bad of ["", "not-a-token", "fcm:abcdefghijklmnop", "ExponentPushToken[]"]) {
      await expect(
        as.mutation(api.push.registerDevice, { expoPushToken: bad, platform: "android" }),
      ).rejects.toThrow();
    }
    expect(await t.run(async (ctx) => ctx.db.query("pushDevices").collect())).toHaveLength(0);
  });

  it("reassigns a token to whoever signed in last, because a token is a phone", async () => {
    const other = await seedUser(t, { authId: "other", email: "other@partybooth.test" });
    const token = pushToken("shared0000");

    await t
      .withIdentity({ subject: "guest" })
      .mutation(api.push.registerDevice, { expoPushToken: token, platform: "ios" });
    await t
      .withIdentity({ subject: "other" })
      .mutation(api.push.registerDevice, { expoPushToken: token, platform: "ios" });

    const devices = await t.run(async (ctx) => ctx.db.query("pushDevices").collect());
    expect(devices).toHaveLength(1);
    // Otherwise the previous account's notifications land in somebody else's hands.
    expect(devices[0]?.userId).toBe(other);
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.pushDeviceRemoved);
  });

  it("re-enables a token the delivery path had switched off", async () => {
    const token = pushToken("revived000");
    await seedPushDevice(t, userId, { token, disabled: true });

    await t
      .withIdentity({ subject: "guest" })
      .mutation(api.push.registerDevice, { expoPushToken: token, platform: "ios" });

    const device = await t.run(async (ctx) => ctx.db.query("pushDevices").first());
    expect(device?.disabledAt).toBeUndefined();
    expect(device?.failureCount).toBe(0);
  });

  it("deletes the row on sign-out, and refuses to touch somebody else's", async () => {
    const token = pushToken("mine000000");
    await t
      .withIdentity({ subject: "guest" })
      .mutation(api.push.registerDevice, { expoPushToken: token, platform: "ios" });

    await seedUser(t, { authId: "other", email: "other@partybooth.test" });
    const stranger = await t
      .withIdentity({ subject: "other" })
      .mutation(api.push.unregisterDevice, { expoPushToken: token });
    expect(stranger.removed).toBe(0);

    const mine = await t
      .withIdentity({ subject: "guest" })
      .mutation(api.push.unregisterDevice, { expoPushToken: token });
    expect(mine.removed).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.query("pushDevices").collect())).toHaveLength(0);
  });

  it("never returns a token to a client", async () => {
    await seedPushDevice(t, userId, { token: pushToken("secret0000") });
    const devices = await t.withIdentity({ subject: "guest" }).query(api.push.myDevices, {});
    expect(JSON.stringify(devices)).not.toContain("secret0000");
  });
});

describe("push preferences", () => {
  let t: T;

  beforeEach(async () => {
    t = makeTest();
    await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
  });

  it("defaults to everything on and the PLAN default threshold", async () => {
    const prefs = await t.withIdentity({ subject: "guest" }).query(api.push.preferences, {});
    expect(prefs.optOut).toEqual([]);
    expect(prefs.pendingThreshold).toBe(DEFAULT_PENDING_THRESHOLD);
  });

  it("stores an opt-out and a threshold, and only writes what was sent", async () => {
    const as = t.withIdentity({ subject: "guest" });
    await as.mutation(api.push.updatePreferences, { optOut: ["eventLifecycle"] });
    await as.mutation(api.push.updatePreferences, { pendingThreshold: 12 });

    const prefs = await as.query(api.push.preferences, {});
    // The threshold write must not have cleared the opt-out.
    expect(prefs.optOut).toEqual(["eventLifecycle"]);
    expect(prefs.pendingThreshold).toBe(12);
  });
});

describe("notification triggers", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    useFakePush();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedPushDevice(t, ownerId, { token: pushToken("owner00000") });
    await seedPushDevice(t, guestId, { token: pushToken("guest00000") });
  });

  afterEach(() => {
    clearFakePush();
    clearFakeStorage();
  });

  it("pings members when an event opens, and never the host who pressed it", async () => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "paused" }));

    await t.withIdentity({ subject: "owner" }).mutation(api.events.setState, {
      eventId,
      state: "live",
    });

    const rows = await pushRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(guestId);
    expect(rows[0]?.category).toBe("eventLifecycle");
    expect(rows[0]?.title).toContain("live");
  });

  it("pings on closing, and respects a per-category opt-out", async () => {
    await t
      .withIdentity({ subject: "guest" })
      .mutation(api.push.updatePreferences, { optOut: ["eventLifecycle"] });

    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.events.setState, { eventId, state: "paused" });

    expect(await pushRows(t)).toHaveLength(0);
  });

  it("does not ping for a transition that is not an opening or a closing", async () => {
    await t.run(async (ctx) => ctx.db.patch(eventId, { state: "draft" }));
    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.events.setState, { eventId, state: "scheduled" });
    expect(await pushRows(t)).toHaveLength(0);
  });

  it("tells an uploader their upload failed, then that it recovered — and not twice", async () => {
    const as = t.withIdentity({ subject: "guest" });
    const captureId = "capture-abcdefgh";

    expect(
      (
        await as.mutation(api.push.reportUploadQueue, {
          eventId,
          captureId,
          event: "failed",
        })
      ).notified,
    ).toBe(1);

    // A second failure report for the same capture is the same fact.
    expect(
      (
        await as.mutation(api.push.reportUploadQueue, {
          eventId,
          captureId,
          event: "failed",
        })
      ).notified,
    ).toBe(0);

    expect(
      (
        await as.mutation(api.push.reportUploadQueue, {
          eventId,
          captureId,
          event: "recovered",
        })
      ).notified,
    ).toBe(1);

    const rows = await pushRows(t);
    expect(rows.map((r) => r.title)).toEqual(["Your upload didn't send", "Sent after all"]);
    expect(rows.every((r) => r.userId === guestId)).toBe(true);
  });

  it("does not announce a recovery nobody was told to worry about", async () => {
    const result = await t.withIdentity({ subject: "guest" }).mutation(api.push.reportUploadQueue, {
      eventId,
      captureId: "capture-ijklmnop",
      event: "recovered",
    });
    expect(result.notified).toBe(0);
    expect(await pushRows(t)).toHaveLength(0);
  });
});

describe("the host pending-threshold ping", () => {
  let t: T;
  let ownerId: Id<"users">;
  let guestId: Id<"users">;
  let eventId: Id<"events">;

  /** Land `count` items in `pending` the way an upload would. */
  async function landPending(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const mediaId = await seedMedia(t, eventId, guestId, { state: "processing" });
      await t.run(async (ctx) => {
        const media = await ctx.db.get(mediaId);
        const event = await ctx.db.get(eventId);
        if (!media || !event) return;
        const { settleAfterProcessing } = await import("./lib/media");
        await settleAfterProcessing(ctx, media, event, Date.now());
      });
    }
  }

  beforeEach(async () => {
    t = makeTest();
    useFakeStorage();
    useFakePush();
    ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    guestId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    eventId = await seedEvent(t, ownerId, { state: "live", moderationMode: "manual" });
    await seedMembership(t, eventId, guestId, "guest");
    await seedPushDevice(t, ownerId, { token: pushToken("owner00000") });
  });

  afterEach(() => {
    clearFakePush();
    clearFakeStorage();
  });

  it("stays quiet under the threshold and fires once when a burst crosses it", async () => {
    await landPending(DEFAULT_PENDING_THRESHOLD - 1);
    expect(await pushRows(t)).toHaveLength(0);

    // The burst: crossing plus five more in the same moment.
    await landPending(6);

    const rows = await pushRows(t);
    // One ping, not six — this is the debounce the requirement asks for.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("hostPendingThreshold");
    expect(rows[0]?.userId).toBe(ownerId);
    expect(rows[0]?.title).toContain(String(DEFAULT_PENDING_THRESHOLD));
  });

  it("honours a per-user threshold", async () => {
    await t.run(async (ctx) => ctx.db.patch(ownerId, { pendingNotifyThreshold: 2 }));
    await landPending(2);
    expect(await pushRows(t)).toHaveLength(1);
  });

  it("fires again once the queue drains and refills", async () => {
    await landPending(DEFAULT_PENDING_THRESHOLD);
    expect(await pushRows(t)).toHaveLength(1);

    // The host works through it. Below the line, the memory is cleared…
    const pending = await t.run(async (ctx) =>
      ctx.db
        .query("media")
        .withIndex("by_event_and_state", (q) => q.eq("eventId", eventId).eq("state", "pending"))
        .collect(),
    );
    await t.withIdentity({ subject: "owner" }).mutation(api.moderation.moderate, {
      eventId,
      mediaIds: pending.map((row) => row._id),
      action: "approve",
    });
    // …which needs one more arrival to be observed.
    await landPending(1);
    expect(await pushRows(t)).toHaveLength(1);

    // …so the next rush pings immediately rather than waiting out a window that
    // started during the last one.
    await landPending(DEFAULT_PENDING_THRESHOLD);
    expect(await pushRows(t)).toHaveLength(2);
  });

  it("never pings a host about their own upload", async () => {
    await seedMembership(t, eventId, ownerId, "owner", "active").catch(() => undefined);
    for (let index = 0; index < DEFAULT_PENDING_THRESHOLD; index += 1) {
      const mediaId = await seedMedia(t, eventId, ownerId, { state: "processing" });
      await t.run(async (ctx) => {
        const media = await ctx.db.get(mediaId);
        const event = await ctx.db.get(eventId);
        if (!media || !event) return;
        const { settleAfterProcessing } = await import("./lib/media");
        await settleAfterProcessing(ctx, media, event, Date.now());
      });
    }
    expect(await pushRows(t)).toHaveLength(0);
  });

  it("respects the opt-out", async () => {
    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.push.updatePreferences, { optOut: ["hostPendingThreshold"] });
    await landPending(DEFAULT_PENDING_THRESHOLD + 3);
    expect(await pushRows(t)).toHaveLength(0);
  });
});

describe("dispatch, receipts and pruning", () => {
  let t: T;
  let userId: Id<"users">;
  let deviceId: Id<"pushDevices">;
  const token = pushToken("device0000");

  async function queueOne(title = "Hello"): Promise<Id<"pushNotifications">> {
    return await t.run(async (ctx) =>
      ctx.db.insert("pushNotifications", {
        userId,
        deviceId,
        category: "eventLifecycle",
        title,
        body: "world",
        state: "queued",
        attempts: 0,
        createdAt: Date.now(),
      }),
    );
  }

  beforeEach(async () => {
    t = makeTest();
    userId = await seedUser(t, { authId: "guest", email: "guest@partybooth.test" });
    deviceId = await seedPushDevice(t, userId, { token });
  });

  afterEach(() => clearFakePush());

  it("chunks at Expo's documented ceiling of 100 messages per request", async () => {
    const push = useFakePush();
    for (let index = 0; index < 250; index += 1) await queueOne(`n${index}`);

    await t.action(internal.push.dispatchQueued, { limit: 250 });

    expect(push.chunkSizes).toEqual([100, 100, 50]);
    expect(push.sent).toHaveLength(250);
    expect(push.sent[0]?.to).toBe(token);
  });

  it("records the ticket and moves the row to sent", async () => {
    useFakePush();
    const id = await queueOne();
    await t.action(internal.push.dispatchQueued, {});

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.state).toBe("sent");
    expect(row?.ticketId).toBeTypeOf("string");
    expect(row?.sentAt).toBeTypeOf("number");
  });

  it("drops everything and blames no device when push is not configured", async () => {
    // No override installed and no EAS_PROJECT_ID: the deployment default.
    clearFakePush();
    const id = await queueOne();
    const result = await t.action(internal.push.dispatchQueued, {});

    expect(result.dropped).toBe(1);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.state).toBe("dropped");
    // The phone did nothing wrong.
    expect((await t.run(async (ctx) => ctx.db.get(deviceId)))?.failureCount).toBe(0);
  });

  it("prunes a token Expo condemns on the ticket", async () => {
    useFakePush({ ticketErrors: { [token]: "DeviceNotRegistered" } });
    const id = await queueOne();
    await t.action(internal.push.dispatchQueued, {});

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.state).toBe("failed");
    expect(row?.errorCode).toBe("DeviceNotRegistered");

    const device = await t.run(async (ctx) => ctx.db.get(deviceId));
    expect(device?.disabledAt).toBeTypeOf("number");
    expect(device?.disabledReason).toBe("deviceNotRegistered");
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.pushDeviceDisabled);
  });

  it("prunes a token Expo condemns on the receipt, fifteen minutes later", async () => {
    // The usual shape: the ticket says "accepted", the receipt says the phone is
    // gone. This is why the sweep, not the send, is what empties the table.
    useFakePush({ receiptErrors: { [token]: "DeviceNotRegistered" } });
    const id = await queueOne();
    await t.action(internal.push.dispatchQueued, {});
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.state).toBe("sent");

    const result = await t.action(internal.push.checkReceipts, {});
    expect(result.pruned).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.state).toBe("failed");
    expect(row?.receiptCheckedAt).toBeTypeOf("number");
    expect((await t.run(async (ctx) => ctx.db.get(deviceId)))?.disabledAt).toBeTypeOf("number");
  });

  it("marks a clean receipt delivered and leaves the device alone", async () => {
    useFakePush();
    const id = await queueOne();
    await t.action(internal.push.dispatchQueued, {});
    await t.action(internal.push.checkReceipts, {});

    expect((await t.run(async (ctx) => ctx.db.get(id)))?.state).toBe("delivered");
    expect((await t.run(async (ctx) => ctx.db.get(deviceId)))?.disabledAt).toBeUndefined();
  });

  it("leaves a ticket with no receipt yet alone, to be asked about again", async () => {
    const push = useFakePush();
    const id = await queueOne();
    await t.action(internal.push.dispatchQueued, {});

    const ticketId = (await t.run(async (ctx) => ctx.db.get(id)))?.ticketId ?? "";
    clearFakePush();
    useFakePush({ withholdReceipts: [ticketId] });
    // The new fake has no memory of the ticket, so withholding is the same shape
    // as Expo not having decided yet.
    void push;

    await t.action(internal.push.checkReceipts, {});
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.state).toBe("sent");
    expect(row?.receiptCheckedAt).toBeUndefined();
  });

  it(`disables a token after ${PUSH_FAILURE_LIMIT} consecutive non-fatal failures`, async () => {
    useFakePush({ ticketErrors: { [token]: "MessageTooBig" } });
    for (let index = 0; index < PUSH_FAILURE_LIMIT; index += 1) {
      await queueOne(`n${index}`);
      await t.action(internal.push.dispatchQueued, {});
      // A disabled device is skipped by `queuedBatch`, so re-enable between
      // rounds only if this is not the last one.
      if (index < PUSH_FAILURE_LIMIT - 1) {
        const device = await t.run(async (ctx) => ctx.db.get(deviceId));
        expect(device?.disabledAt).toBeUndefined();
      }
    }
    const device = await t.run(async (ctx) => ctx.db.get(deviceId));
    expect(device?.failureCount).toBe(PUSH_FAILURE_LIMIT);
    expect(device?.disabledReason).toBe("failureLimit");
  });

  it("does not blame the device for a project-level rate limit", async () => {
    useFakePush({ ticketErrors: { [token]: "MessageRateExceeded" } });
    await queueOne();
    await t.action(internal.push.dispatchQueued, {});

    const device = await t.run(async (ctx) => ctx.db.get(deviceId));
    expect(device?.failureCount).toBe(0);
    expect(device?.disabledAt).toBeUndefined();
  });

  it("skips a queued row whose device has since been disabled", async () => {
    const push = useFakePush();
    const id = await queueOne();
    await t.run(async (ctx) => ctx.db.patch(deviceId, { disabledAt: Date.now() }));

    await t.action(internal.push.dispatchQueued, {});
    expect(push.sent).toHaveLength(0);
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.state).toBe("queued");
  });

  it("is driven by the scheduler from an ordinary mutation", async () => {
    // The queue exists because a mutation cannot send. This is the hop.
    const push = useFakePush();
    const ownerId = await seedUser(t, { authId: "owner", email: "owner@partybooth.test" });
    const eventId = await seedEvent(t, ownerId, { state: "paused" });
    await seedMembership(t, eventId, userId, "guest");

    await t
      .withIdentity({ subject: "owner" })
      .mutation(api.events.setState, { eventId, state: "live" });

    await runScheduled(t);

    // Asserted by *content* rather than by the fake's length. convex-test drives
    // the scheduler with real `setTimeout`s, so a job queued by an earlier suite
    // in this file can land in whichever fake is installed when its timer fires
    // — see the note on `runScheduled`. What this test claims is that an
    // ordinary mutation caused *this* message to reach the adapter, and that is
    // what is checked.
    expect(push.sent.some((message) => message.to === token)).toBe(true);
    expect(push.sent.find((message) => message.to === token)?.title).toContain("live");

    const rows = await pushRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("sent");
  });
});
