import {
  eventClosedMessage,
  eventLifecyclePayload,
  eventOpenedMessage,
  pendingThresholdMessage,
  pendingThresholdOf,
  pendingThresholdPayload,
  PUSH_DEBOUNCE_MS,
  shouldNotifyDebounced,
  shouldNotifyPendingThreshold,
  shouldNotifyUploadQueue,
  UPLOAD_QUEUE_FAILED_MARK,
  uploadFailedMessage,
  uploadRecoveredMessage,
  uploadStatusPayload,
  wantsPushCategory,
  type LifecycleTransition,
  type PushCategory,
  type PushDebounceState,
  type PushMessageBody,
  type UploadQueueEvent,
} from "@partybooth/contracts/push";
import type { FunctionReference } from "convex/server";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";

/**
 * Deciding what to notify, and queueing it.
 *
 * The split that shapes this file is that **a Convex mutation cannot send**. It
 * has no `fetch`, so the decision and the delivery are necessarily two
 * transactions with the scheduler between them. Everything here is the decision
 * half: preferences, debounce, which devices, what the message says. The
 * delivery half is `convex/push.ts`'s action, talking to the adapter.
 *
 * Three rules hold across every trigger:
 *
 * 1. **Never throw onto the caller's path.** A notification is the least
 *    important thing happening in any mutation that produces one. Approving a
 *    photo must not fail because a host has no devices, or because the
 *    deployment has no Expo project. Every entry point here returns a count.
 * 2. **The preference is checked before the row is written**, not before the
 *    send. A queued row is a record that we decided to buzz somebody, and we
 *    should not be recording decisions we are not allowed to make.
 * 3. **The debounce is a database read-decide-write inside the caller's
 *    mutation**, which makes it a serialisable transaction — so thirty photos
 *    landing in the same second cannot each observe "nothing sent yet" and each
 *    send. That is the whole "a burst sends one ping" requirement, and it is not
 *    achievable with anything held in an isolate.
 */

/** Same cast as `deletion.ts`: the generic `AnyApi` fallback until codegen runs. */
const pushFunctions = internal.push as unknown as {
  dispatchQueued: FunctionReference<"action", "internal", { limit?: number }, unknown>;
};

/* -------------------------------------------------------------------------- */
/* Debounce persistence                                                       */
/* -------------------------------------------------------------------------- */

export function pendingThrottleKey(eventId: Id<"events">, userId: Id<"users">): string {
  return `pending:${eventId}:${userId}`;
}

export function lifecycleThrottleKey(eventId: Id<"events">, userId: Id<"users">): string {
  return `lifecycle:${eventId}:${userId}`;
}

export function uploadThrottleKey(userId: Id<"users">, captureId: string): string {
  return `upload:${userId}:${captureId}`;
}

async function readThrottle(ctx: ReadCtx, key: string): Promise<PushDebounceState | undefined> {
  const row = await ctx.db
    .query("notificationThrottles")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!row) return undefined;
  return {
    lastSentAt: row.lastSentAt,
    ...(row.lastValue === undefined ? {} : { lastValue: row.lastValue }),
  };
}

async function writeThrottle(
  ctx: MutationCtx,
  key: string,
  now: number,
  lastValue?: number,
): Promise<void> {
  const existing = await ctx.db
    .query("notificationThrottles")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  const fields = { lastSentAt: now, updatedAt: now };
  if (existing) {
    // `undefined` is how Convex clears an optional field, and it is passed
    // explicitly so a cleared memory really is cleared rather than inheriting
    // the previous value — see `clearThrottle`.
    await ctx.db.patch(existing._id, { ...fields, lastValue });
    return;
  }
  await ctx.db.insert("notificationThrottles", {
    key,
    ...fields,
    ...(lastValue === undefined ? {} : { lastValue }),
  });
}

async function clearThrottle(ctx: MutationCtx, key: string): Promise<void> {
  const existing = await ctx.db
    .query("notificationThrottles")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

/* -------------------------------------------------------------------------- */
/* Queueing                                                                   */
/* -------------------------------------------------------------------------- */

export interface QueueParams {
  userId: Id<"users">;
  category: PushCategory;
  message: PushMessageBody;
  eventId?: Id<"events"> | undefined;
  /** Small routing payload the app reads to open the right screen. */
  data?: Record<string, string> | undefined;
  badge?: number | undefined;
  now: number;
}

/**
 * Write one `queued` row per enabled device, and ask the dispatcher to run.
 *
 * Returns how many rows were written, which is `0` for every ordinary reason a
 * notification does not happen: the account opted the category out, the account
 * is not active, it has no devices, or every device it has is disabled. None of
 * those is an error and none of them is logged — they are the normal state of
 * most accounts most of the time.
 */
export async function queueNotification(ctx: MutationCtx, params: QueueParams): Promise<number> {
  const user = await ctx.db.get(params.userId);
  if (!user || user.accountState !== "active") return 0;

  if (
    !wantsPushCategory(
      {
        ...(user.notificationOptOut === undefined ? {} : { optOut: user.notificationOptOut }),
        ...(user.pendingNotifyThreshold === undefined
          ? {}
          : { pendingThreshold: user.pendingNotifyThreshold }),
      },
      params.category,
    )
  ) {
    return 0;
  }

  const devices = (
    await ctx.db
      .query("pushDevices")
      .withIndex("by_user", (q) => q.eq("userId", params.userId))
      .collect()
  ).filter((device) => device.disabledAt === undefined);

  if (devices.length === 0) return 0;

  for (const device of devices) {
    await ctx.db.insert("pushNotifications", {
      userId: params.userId,
      deviceId: device._id,
      category: params.category,
      ...(params.eventId === undefined ? {} : { eventId: params.eventId }),
      title: params.message.title,
      body: params.message.body,
      ...(params.data === undefined ? {} : { data: params.data }),
      state: "queued",
      attempts: 0,
      createdAt: params.now,
    });
  }

  // Fire-and-forget: the dispatcher drains whatever is queued, so several
  // mutations queueing in the same second collapse into one run rather than
  // racing. It never throws onto this path — see `push.dispatchQueued`.
  await ctx.scheduler.runAfter(0, pushFunctions.dispatchQueued, {});

  return devices.length;
}

/* -------------------------------------------------------------------------- */
/* Trigger: the host pending-queue threshold                                  */
/* -------------------------------------------------------------------------- */

export interface PendingThresholdParams {
  event: Doc<"events">;
  /** How many items are waiting. Read from the event's exact counters. */
  pending: number;
  /** Never ping the person whose own action produced the item. */
  excludeUserId?: Id<"users"> | undefined;
  now: number;
}

/**
 * Tell the hosts their queue has built up — once per burst, per host.
 *
 * The threshold is **per user** (`users.pendingNotifyThreshold`, default 5 from
 * PLAN.md) because a host running a fifty-guest party and one running a dinner
 * want different numbers. The debounce memory is per `(event, host)`, so two
 * co-hosts are each told once rather than one of them absorbing the other's
 * quiet window.
 *
 * Below the threshold the memory is **cleared**, which is what makes a second
 * rush ping immediately instead of waiting out a window that started during the
 * first one.
 */
export async function notifyPendingThreshold(
  ctx: MutationCtx,
  params: PendingThresholdParams,
): Promise<number> {
  const hosts = await activeHostUserIds(ctx, params.event._id);
  let queued = 0;

  for (const userId of hosts) {
    if (userId === params.excludeUserId) continue;
    const user = await ctx.db.get(userId);
    if (!user || user.accountState !== "active") continue;

    const threshold = pendingThresholdOf(
      user.pendingNotifyThreshold === undefined
        ? {}
        : { pendingThreshold: user.pendingNotifyThreshold },
    );
    const key = pendingThrottleKey(params.event._id, userId);
    const decision = shouldNotifyPendingThreshold({
      pending: params.pending,
      threshold,
      state: await readThrottle(ctx, key),
      now: params.now,
    });

    if (!decision.notify) {
      if (decision.reason === "belowThreshold") await clearThrottle(ctx, key);
      continue;
    }

    const sent = await queueNotification(ctx, {
      userId,
      category: "hostPendingThreshold",
      message: pendingThresholdMessage(params.event.name, params.pending),
      eventId: params.event._id,
      data: pendingThresholdPayload(params.event._id),
      now: params.now,
    });

    // The window is spent whether or not a device took it. Otherwise a host with
    // no phone registered would re-evaluate — and re-write — on every single
    // upload for the whole party.
    await writeThrottle(ctx, key, params.now, params.pending);
    queued += sent;
  }

  return queued;
}

/** Owners and co-hosts with a live membership. The owner row is a membership. */
export async function activeHostUserIds(
  ctx: ReadCtx,
  eventId: Id<"events">,
): Promise<Id<"users">[]> {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_event_and_status", (q) => q.eq("eventId", eventId).eq("status", "active"))
    .collect();
  return members.filter((m) => m.role !== "guest").map((m) => m.userId);
}

/* -------------------------------------------------------------------------- */
/* Trigger: the event opened or closed                                        */
/* -------------------------------------------------------------------------- */

/**
 * Tell everybody in the party that it has opened, or wrapped up.
 *
 * Everybody with a live membership, minus whoever pressed the button — telling
 * the host they opened their own party is the definition of noise. Debounced per
 * `(event, member)` at a minute, which is enough to absorb a host toggling
 * `live` → `paused` → `live` while they work out which button they wanted.
 */
export async function notifyEventLifecycle(
  ctx: MutationCtx,
  params: {
    event: Doc<"events">;
    transition: LifecycleTransition;
    actorUserId?: Id<"users"> | undefined;
    now: number;
  },
): Promise<number> {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_event_and_status", (q) =>
      q.eq("eventId", params.event._id).eq("status", "active"),
    )
    .collect();

  const message =
    params.transition === "opened"
      ? eventOpenedMessage(params.event.name)
      : eventClosedMessage(params.event.name);

  let queued = 0;
  for (const membership of members) {
    if (membership.userId === params.actorUserId) continue;

    const key = lifecycleThrottleKey(params.event._id, membership.userId);
    if (
      !shouldNotifyDebounced(
        "eventLifecycle",
        await readThrottle(ctx, key),
        params.now,
        PUSH_DEBOUNCE_MS.eventLifecycle,
      )
    ) {
      continue;
    }

    queued += await queueNotification(ctx, {
      userId: membership.userId,
      category: "eventLifecycle",
      message,
      eventId: params.event._id,
      data: eventLifecyclePayload(params.event._id, params.transition),
      now: params.now,
    });
    await writeThrottle(ctx, key, params.now);
  }
  return queued;
}

/* -------------------------------------------------------------------------- */
/* Trigger: an upload failed, and then recovered                              */
/* -------------------------------------------------------------------------- */

/**
 * The client's durable queue reporting on itself.
 *
 * Only the uploader is told, and only about their own capture. The pairing is
 * the interesting part: a recovery ping is sent **only if** the failure ping
 * was, because "your photo sent" is noise on its own and reassurance after "your
 * photo did not send". `lastValue` on the throttle row is that memory, and the
 * row is deleted on recovery so a capture that fails again later starts clean.
 */
export async function notifyUploadQueue(
  ctx: MutationCtx,
  params: {
    user: Doc<"users">;
    event: Doc<"events">;
    captureId: string;
    transition: UploadQueueEvent;
    now: number;
  },
): Promise<number> {
  const key = uploadThrottleKey(params.user._id, params.captureId);
  const state = await readThrottle(ctx, key);

  if (!shouldNotifyUploadQueue(params.transition, state)) return 0;

  const message =
    params.transition === "failed"
      ? uploadFailedMessage(params.event.name)
      : uploadRecoveredMessage(params.event.name);

  const queued = await queueNotification(ctx, {
    userId: params.user._id,
    category: "uploadStatus",
    message,
    eventId: params.event._id,
    data: uploadStatusPayload(params.event._id, params.captureId, params.transition),
    now: params.now,
  });

  if (params.transition === "failed") {
    await writeThrottle(ctx, key, params.now, UPLOAD_QUEUE_FAILED_MARK);
  } else {
    // The story is over. Deleting rather than restamping means the same capture
    // failing again next week is announced again, which is what a person wants.
    await clearThrottle(ctx, key);
  }

  return queued;
}
