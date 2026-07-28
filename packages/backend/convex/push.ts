import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import {
  chunk,
  DEFAULT_PENDING_THRESHOLD,
  EXPO_PUSH_RECEIPT_CHUNK_SIZE,
  EXPO_PUSH_SEND_CHUNK_SIZE,
  nextDeviceHealth,
  pendingThresholdOf,
  PUSH_CATEGORIES,
  PUSH_RECEIPT_DELAY_MS,
  shouldPruneToken,
  truncateToPayload,
  type ExpoPushMessage,
  type PushCategory,
} from "@partybooth/contracts/push";
import {
  registerPushDeviceInputSchema,
  reportUploadQueueInputSchema,
  unregisterPushDeviceInputSchema,
  updateNotificationPreferencesInputSchema,
} from "@partybooth/contracts";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { forbidden } from "./lib/errors";
import { requireActiveUser, requireEventActor, requireUser } from "./lib/guards";
import { parseInput } from "./lib/input";
import { notifyUploadQueue } from "./lib/notifications";
import { PushNotConfiguredError, resolvePushAdapter } from "./lib/push";
import { reportError } from "./lib/sentry";
import { pushCategory, pushPlatform } from "./lib/validators";

/**
 * Push notifications: registering a device, choosing what it hears, and getting
 * a message onto a lock screen.
 *
 * The whole file is shaped by one fact: **a Convex mutation has no `fetch`.**
 * Deciding to notify somebody happens inside the mutation that caused it (a
 * photo landing, an event opening), so it has to be a database write; the send
 * has to be an action; and something has to survive the gap between them. That
 * something is `pushNotifications`, and it is why this is a queue rather than a
 * function call.
 *
 * The whole chain is testable offline. `lib/push/` puts the Expo HTTP calls
 * behind an adapter with a fake, so a suite can assert chunking, receipt
 * handling and token pruning without a network, a credential, or a phone. A
 * deployment with no `EAS_PROJECT_ID` resolves the unconfigured adapter and the
 * dispatcher marks its rows `dropped` — nothing on a request path ever throws
 * because push is not set up.
 */

/** Same cast as `deletion.ts`: the generic `AnyApi` fallback until codegen runs. */
const pushFunctions = internal.push as unknown as {
  queuedBatch: FunctionReference<"query", "internal", { limit?: number }, QueuedRow[]>;
  applyTickets: FunctionReference<"mutation", "internal", { results: TicketResult[] }, null>;
  dropQueued: FunctionReference<
    "mutation",
    "internal",
    { notificationIds: Id<"pushNotifications">[]; reason: string },
    null
  >;
  awaitingReceipts: FunctionReference<
    "query",
    "internal",
    { limit?: number },
    { notificationId: Id<"pushNotifications">; ticketId: string }[]
  >;
  applyReceipts: FunctionReference<"mutation", "internal", { results: ReceiptResult[] }, null>;
  checkReceipts: FunctionReference<"action", "internal", { limit?: number }, unknown>;
};

interface QueuedRow {
  notificationId: Id<"pushNotifications">;
  deviceId: Id<"pushDevices">;
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface TicketResult {
  notificationId: Id<"pushNotifications">;
  ok: boolean;
  ticketId?: string;
  errorCode?: string;
  error?: string;
}

interface ReceiptResult {
  notificationId: Id<"pushNotifications">;
  ok: boolean;
  errorCode?: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Claim an Expo push token for this account.
 *
 * Two dedupe rules, and the second is the one that matters at a party:
 *
 * - **Same account, same token** → the existing row is refreshed rather than
 *   duplicated. The app calls this on every launch, because a token can rotate
 *   under the app at any time, so this is the common case by a wide margin.
 * - **Different account, same token** → the row is *reassigned*. An Expo push
 *   token belongs to an app **installation**, not to a person. A phone handed
 *   over so a friend can sign in and post their photos would otherwise keep
 *   buzzing for the previous account — and, worse, the previous account's
 *   notifications would be delivered to somebody else's hands. Reassignment is
 *   the only correct answer, and it is audited on both sides.
 *
 * Registering also **re-enables** a token the delivery path had switched off. A
 * device that reappears with a working token has, by definition, contradicted
 * the `DeviceNotRegistered` that killed it.
 */
export const registerDevice = mutation({
  args: {
    expoPushToken: v.string(),
    platform: pushPlatform,
    deviceName: v.optional(v.string()),
  },
  returns: v.object({ deviceId: v.id("pushDevices"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(registerPushDeviceInputSchema, args);
    const now = Date.now();

    const existing = await ctx.db
      .query("pushDevices")
      .withIndex("by_token", (q) => q.eq("expoPushToken", input.expoPushToken))
      .unique();

    if (existing) {
      const reassigned = existing.userId !== user._id;
      await ctx.db.patch(existing._id, {
        userId: user._id,
        platform: input.platform,
        ...(input.deviceName === undefined ? {} : { deviceName: input.deviceName }),
        failureCount: 0,
        disabledAt: undefined,
        disabledReason: undefined,
        lastSeenAt: now,
        updatedAt: now,
      });

      if (reassigned) {
        await writeAuditEvent(ctx, {
          action: AUDIT_ACTIONS.pushDeviceRemoved,
          subjectType: "pushDevice",
          subjectId: existing._id,
          actor: { userId: user._id },
          // The row id, never the token: an audit log must not become a list of
          // capabilities to reach people's lock screens.
          metadata: { reason: "reassigned", previousUserId: existing.userId },
          now,
        });
      }

      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.pushDeviceRegistered,
        subjectType: "pushDevice",
        subjectId: existing._id,
        actor: { userId: user._id },
        metadata: { platform: input.platform, reassigned },
        now,
      });

      return { deviceId: existing._id, created: false };
    }

    const deviceId = await ctx.db.insert("pushDevices", {
      userId: user._id,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      ...(input.deviceName === undefined ? {} : { deviceName: input.deviceName }),
      failureCount: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.pushDeviceRegistered,
      subjectType: "pushDevice",
      subjectId: deviceId,
      actor: { userId: user._id },
      metadata: { platform: input.platform, reassigned: false },
      now,
    });

    return { deviceId, created: true };
  },
});

/**
 * Give a token up — the sign-out path.
 *
 * The row is **deleted**, not disabled. A disabled row would be re-enabled by
 * the next `registerDevice` from whoever signs in on that phone next, which is
 * right for a token that Expo rejected and wrong for a person who deliberately
 * signed out. `requireUser` rather than `requireActiveUser`: an account being
 * locked mid-session must still be able to detach its phone.
 */
export const unregisterDevice = mutation({
  args: { expoPushToken: v.string() },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const input = parseInput(unregisterPushDeviceInputSchema, args);
    const now = Date.now();

    const existing = await ctx.db
      .query("pushDevices")
      .withIndex("by_token", (q) => q.eq("expoPushToken", input.expoPushToken))
      .unique();

    // Only your own. A token you do not hold is not yours to retire, and
    // answering "removed: 0" for both "no such token" and "somebody else's"
    // keeps this from confirming that a token is registered.
    if (!existing || existing.userId !== user._id) return { removed: 0 };

    await ctx.db.delete(existing._id);
    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.pushDeviceRemoved,
      subjectType: "pushDevice",
      subjectId: existing._id,
      actor: { userId: user._id },
      metadata: { reason: "signedOut" },
      now,
    });
    return { removed: 1 };
  },
});

/** Sign out everywhere: drop every device this account has registered. */
export const unregisterAllDevices = mutation({
  args: {},
  returns: v.object({ removed: v.number() }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const now = Date.now();

    const devices = await ctx.db
      .query("pushDevices")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    for (const device of devices) {
      await ctx.db.delete(device._id);
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.pushDeviceRemoved,
        subjectType: "pushDevice",
        subjectId: device._id,
        actor: { userId: user._id },
        metadata: { reason: "signedOutEverywhere" },
        now,
      });
    }
    return { removed: devices.length };
  },
});

/** This account's registered devices. No tokens — see `MediaView` for the rule. */
export const myDevices = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("pushDevices"),
      platform: pushPlatform,
      deviceName: v.optional(v.string()),
      enabled: v.boolean(),
      disabledReason: v.optional(v.string()),
      lastSeenAt: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const devices = await ctx.db
      .query("pushDevices")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return devices
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((device) => ({
        id: device._id,
        platform: device.platform,
        ...(device.deviceName === undefined ? {} : { deviceName: device.deviceName }),
        enabled: device.disabledAt === undefined,
        ...(device.disabledReason === undefined ? {} : { disabledReason: device.disabledReason }),
        lastSeenAt: device.lastSeenAt,
        createdAt: device.createdAt,
      }));
  },
});

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

export const preferences = query({
  args: {},
  returns: v.object({
    categories: v.array(pushCategory),
    optOut: v.array(pushCategory),
    pendingThreshold: v.number(),
    defaultPendingThreshold: v.number(),
  }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return {
      categories: [...PUSH_CATEGORIES],
      optOut: user.notificationOptOut ?? [],
      pendingThreshold: pendingThresholdOf(
        user.pendingNotifyThreshold === undefined
          ? {}
          : { pendingThreshold: user.pendingNotifyThreshold },
      ),
      defaultPendingThreshold: DEFAULT_PENDING_THRESHOLD,
    };
  },
});

/**
 * Set the opt-out list and the host threshold.
 *
 * Both fields are optional and only the ones sent are written, so a settings
 * screen can post the one toggle that moved. Two phones open on the same account
 * then race over one field rather than over the whole object, which is the
 * difference between "the last write wins" and "the last write reverts a
 * preference nobody touched".
 */
export const updatePreferences = mutation({
  args: {
    optOut: v.optional(v.array(pushCategory)),
    pendingThreshold: v.optional(v.number()),
  },
  returns: v.object({
    optOut: v.array(pushCategory),
    pendingThreshold: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(updateNotificationPreferencesInputSchema, args);
    const now = Date.now();

    const optOut =
      input.optOut === undefined ? (user.notificationOptOut ?? []) : dedupeCategories(input.optOut);
    const threshold = input.pendingThreshold ?? user.pendingNotifyThreshold;

    await ctx.db.patch(user._id, {
      notificationOptOut: optOut,
      ...(threshold === undefined ? {} : { pendingNotifyThreshold: threshold }),
      updatedAt: now,
    });

    return {
      optOut,
      pendingThreshold: pendingThresholdOf(
        threshold === undefined ? {} : { pendingThreshold: threshold },
      ),
    };
  },
});

function dedupeCategories(values: readonly PushCategory[]): PushCategory[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------- */
/* Trigger: a client's upload queue                                           */
/* -------------------------------------------------------------------------- */

/**
 * The client telling us what happened to one item in its durable queue.
 *
 * The server cannot observe this for itself: an upload that never reaches
 * storage produces no callback, no media row and no grant consumption, so the
 * *only* witness is the client that gave up. Which is also why this is reported
 * rather than trusted — the report can only ever notify **its own sender** about
 * **its own capture**, so a client lying about it is a client buzzing its own
 * phone.
 */
export const reportUploadQueue = mutation({
  args: {
    eventId: v.id("events"),
    captureId: v.string(),
    event: v.union(v.literal("failed"), v.literal("recovered")),
    attempts: v.optional(v.number()),
  },
  returns: v.object({ notified: v.number() }),
  handler: async (ctx, args) => {
    // `requireEventActor` hides an event this account has no relationship with,
    // and — since Sprint 5 — refuses one whose owner is locked.
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot do that right now.");
    }
    const input = parseInput(reportUploadQueueInputSchema, args);

    const notified = await notifyUploadQueue(ctx, {
      user: actor.user,
      event: actor.event,
      captureId: input.captureId,
      transition: input.event,
      now: Date.now(),
    });
    return { notified };
  },
});

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

const queuedRowValidator = v.object({
  notificationId: v.id("pushNotifications"),
  deviceId: v.id("pushDevices"),
  token: v.string(),
  title: v.string(),
  body: v.string(),
  data: v.optional(v.record(v.string(), v.string())),
});

/**
 * The next batch to send, oldest first.
 *
 * A notification whose device has since been disabled or deleted is skipped
 * here rather than sent and failed: a phone that told us its token was dead five
 * minutes ago should not be asked again just because a mutation queued a row
 * before we knew.
 */
export const queuedBatch = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(queuedRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushNotifications")
      .withIndex("by_state_and_createdAt", (q) => q.eq("state", "queued"))
      .order("asc")
      .take(args.limit ?? 300);

    const out: QueuedRow[] = [];
    for (const row of rows) {
      const device = await ctx.db.get(row.deviceId);
      if (!device || device.disabledAt !== undefined) continue;
      out.push({
        notificationId: row._id,
        deviceId: row.deviceId,
        token: device.expoPushToken,
        title: row.title,
        body: row.body,
        ...(row.data === undefined ? {} : { data: row.data }),
      });
    }
    return out;
  },
});

const ticketResultValidator = v.object({
  notificationId: v.id("pushNotifications"),
  ok: v.boolean(),
  ticketId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  error: v.optional(v.string()),
});

/**
 * Record what Expo said about each message, and act on it.
 *
 * The device health rule is the contract's (`nextDeviceHealth`): a
 * `DeviceNotRegistered` kills the token at once, anything else is counted and
 * three consecutive counts do the same thing more slowly, and a success resets
 * the counter so a phone that was in a tunnel is not disabled a week later by
 * three failures spread across a month.
 */
export const applyTickets = internalMutation({
  args: { results: v.array(ticketResultValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    for (const result of args.results) {
      const notification = await ctx.db.get(result.notificationId);
      if (!notification) continue;

      await ctx.db.patch(notification._id, {
        state: result.ok ? "sent" : "failed",
        attempts: notification.attempts + 1,
        ...(result.ticketId === undefined ? {} : { ticketId: result.ticketId }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.ok ? { sentAt: now } : {}),
      });

      await applyDeviceOutcome(ctx, notification.deviceId, {
        ok: result.ok,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        now,
      });
    }
    return null;
  },
});

/** Mark a batch undeliverable without blaming any device — no Expo project. */
export const dropQueued = internalMutation({
  args: { notificationIds: v.array(v.id("pushNotifications")), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.notificationIds) {
      const row = await ctx.db.get(id);
      if (!row || row.state !== "queued") continue;
      await ctx.db.patch(id, {
        state: "dropped",
        error: args.reason,
        attempts: row.attempts + 1,
      });
    }
    return null;
  },
});

/**
 * Send everything that is queued.
 *
 * Chunked at Expo's documented ceiling of 100 messages per request and sent
 * sequentially — the docs ask for at most about six concurrent connections and
 * this product's whole party fits in one or two chunks, so serial is both
 * simpler and inside the guidance. A transport failure leaves the chunk
 * `queued`: the next mutation that notifies anybody schedules another run, and
 * the receipt sweep is not blocked behind it.
 */
export const dispatchQueued = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ sent: v.number(), failed: v.number(), dropped: v.number() }),
  handler: async (ctx, args): Promise<{ sent: number; failed: number; dropped: number }> => {
    const batch: QueuedRow[] = await ctx.runQuery(pushFunctions.queuedBatch, {
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    if (batch.length === 0) return { sent: 0, failed: 0, dropped: 0 };

    const adapter = resolvePushAdapter();
    if (!adapter.configured) {
      await ctx.runMutation(pushFunctions.dropQueued, {
        notificationIds: batch.map((row) => row.notificationId),
        reason: "Expo push is not configured on this deployment.",
      });
      return { sent: 0, failed: 0, dropped: batch.length };
    }

    let sent = 0;
    let failed = 0;
    let anyAccepted = false;

    for (const group of chunk(batch, EXPO_PUSH_SEND_CHUNK_SIZE)) {
      const messages: ExpoPushMessage[] = group.map((row) =>
        truncateToPayload({
          to: row.token,
          title: row.title,
          body: row.body,
          sound: "default",
          ...(row.data === undefined ? {} : { data: row.data }),
        }),
      );

      let tickets;
      try {
        tickets = await adapter.sendChunk(messages);
      } catch (error) {
        if (error instanceof PushNotConfiguredError) {
          await ctx.runMutation(pushFunctions.dropQueued, {
            notificationIds: group.map((row) => row.notificationId),
            reason: "Expo push is not configured on this deployment.",
          });
          continue;
        }
        // Transport failure: the rows stay `queued` and the next dispatch picks
        // them up. Reported rather than logged — nobody tails Convex logs on
        // party night.
        reportError({ scope: "push.dispatch", error, extra: { chunk: group.length } });
        continue;
      }

      const results: TicketResult[] = group.map((row, index) => {
        const ticket = tickets[index];
        if (ticket === undefined) {
          return { notificationId: row.notificationId, ok: false, error: "No ticket returned." };
        }
        if (ticket.status === "ok") {
          anyAccepted = true;
          return { notificationId: row.notificationId, ok: true, ticketId: ticket.id };
        }
        return {
          notificationId: row.notificationId,
          ok: false,
          ...(ticket.details?.error === undefined ? {} : { errorCode: ticket.details.error }),
          error: ticket.message,
        };
      });

      sent += results.filter((r) => r.ok).length;
      failed += results.filter((r) => !r.ok).length;
      await ctx.runMutation(pushFunctions.applyTickets, { results });
    }

    // Expo's own guidance: read receipts about fifteen minutes later. They are
    // discarded after twenty-four hours, so being late is fine and being early
    // means asking about something Expo has not decided yet.
    if (anyAccepted) {
      await ctx.scheduler.runAfter(PUSH_RECEIPT_DELAY_MS, pushFunctions.checkReceipts, {});
    }

    return { sent, failed, dropped: 0 };
  },
});

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tickets we have not read a receipt for.
 *
 * A ticket says Expo **accepted** the message; the receipt says whether Apple or
 * Google took it. `DeviceNotRegistered` almost always arrives here rather than
 * on the ticket, which is why the receipt sweep — not the send — is what
 * actually prunes the table.
 */
export const awaitingReceipts = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({ notificationId: v.id("pushNotifications"), ticketId: v.string() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushNotifications")
      .withIndex("by_state_and_createdAt", (q) => q.eq("state", "sent"))
      .order("asc")
      .take(args.limit ?? EXPO_PUSH_RECEIPT_CHUNK_SIZE);

    return rows
      .filter((row) => row.ticketId !== undefined && row.receiptCheckedAt === undefined)
      .map((row) => ({ notificationId: row._id, ticketId: row.ticketId as string }));
  },
});

const receiptResultValidator = v.object({
  notificationId: v.id("pushNotifications"),
  ok: v.boolean(),
  errorCode: v.optional(v.string()),
  error: v.optional(v.string()),
});

export const applyReceipts = internalMutation({
  args: { results: v.array(receiptResultValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const result of args.results) {
      const notification = await ctx.db.get(result.notificationId);
      if (!notification) continue;

      await ctx.db.patch(notification._id, {
        state: result.ok ? "delivered" : "failed",
        receiptCheckedAt: now,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(result.error === undefined ? {} : { error: result.error }),
      });

      await applyDeviceOutcome(ctx, notification.deviceId, {
        ok: result.ok,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        now,
      });
    }
    return null;
  },
});

/**
 * Read receipts and prune the tokens they condemn.
 *
 * A ticket id with no receipt yet is left exactly alone — `receiptCheckedAt`
 * stays unset, so the next sweep asks about it again. Expo keeps receipts for
 * twenty-four hours; a row still unanswered after that simply stops being asked
 * about when it falls out of the batch, which is the right outcome for a
 * notification nobody can say anything more about.
 */
export const checkReceipts = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ checked: v.number(), pruned: v.number() }),
  handler: async (ctx, args): Promise<{ checked: number; pruned: number }> => {
    const outstanding: { notificationId: Id<"pushNotifications">; ticketId: string }[] =
      await ctx.runQuery(pushFunctions.awaitingReceipts, {
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
    if (outstanding.length === 0) return { checked: 0, pruned: 0 };

    const adapter = resolvePushAdapter();
    if (!adapter.configured) return { checked: 0, pruned: 0 };

    let checked = 0;
    let pruned = 0;

    for (const group of chunk(outstanding, EXPO_PUSH_RECEIPT_CHUNK_SIZE)) {
      let receipts;
      try {
        receipts = await adapter.getReceipts(group.map((row) => row.ticketId));
      } catch (error) {
        if (!(error instanceof PushNotConfiguredError)) {
          reportError({ scope: "push.receipts", error, extra: { chunk: group.length } });
        }
        continue;
      }

      const results: ReceiptResult[] = [];
      for (const row of group) {
        const receipt = receipts[row.ticketId];
        // No receipt yet is not a verdict. Leave it for the next sweep.
        if (receipt === undefined) continue;
        if (receipt.status === "ok") {
          results.push({ notificationId: row.notificationId, ok: true });
          continue;
        }
        if (shouldPruneToken(receipt.details?.error)) pruned += 1;
        results.push({
          notificationId: row.notificationId,
          ok: false,
          ...(receipt.details?.error === undefined ? {} : { errorCode: receipt.details.error }),
          error: receipt.message,
        });
      }

      if (results.length > 0) {
        checked += results.length;
        await ctx.runMutation(pushFunctions.applyReceipts, { results });
      }
    }

    return { checked, pruned };
  },
});

/* -------------------------------------------------------------------------- */
/* Device health                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Move a device's failure counter and switch it off if the answer says to.
 *
 * The decision is `nextDeviceHealth` in the contract, so ticket errors and
 * receipt errors are judged by exactly the same rule — they are the same fact
 * arriving at two different times, and a token pruned on one path and kept on
 * the other would be the sort of inconsistency that only shows up as "some
 * people stopped getting notifications".
 */
async function applyDeviceOutcome(
  ctx: MutationCtx,
  deviceId: Id<"pushDevices">,
  outcome: { ok: boolean; errorCode?: string | undefined; now: number },
): Promise<void> {
  const device = await ctx.db.get(deviceId);
  if (!device) return;

  const next = nextDeviceHealth(
    {
      failureCount: device.failureCount,
      ...(device.disabledAt === undefined ? {} : { disabledAt: device.disabledAt }),
    },
    outcome,
  );

  const becameDisabled = device.disabledAt === undefined && next.disabledAt !== undefined;

  await ctx.db.patch(deviceId, {
    failureCount: next.failureCount,
    disabledAt: next.disabledAt,
    ...(next.disabledAt === undefined
      ? { disabledReason: undefined }
      : {
          disabledReason: shouldPruneToken(outcome.errorCode)
            ? "deviceNotRegistered"
            : "failureLimit",
        }),
    updatedAt: outcome.now,
  });

  if (becameDisabled) {
    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.pushDeviceDisabled,
      subjectType: "pushDevice",
      subjectId: deviceId,
      metadata: {
        // The code, not the token. `DeviceNotRegistered` is the interesting one
        // and it is the reason this sweep exists.
        errorCode: outcome.errorCode ?? "unknown",
        failureCount: next.failureCount,
      },
      now: outcome.now,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether this deployment can send at all, and what it is queueing.
 *
 * Host-scoped rather than open, because it names infrastructure. It answers the
 * one question that is otherwise unanswerable from a phone on party night:
 * "is nothing buzzing because nothing happened, or because push is not wired
 * up?".
 */
export const status = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    provider: v.string(),
    configured: v.boolean(),
    authenticated: v.boolean(),
    queued: v.number(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.role !== "owner" && actor.role !== "cohost") throw forbidden();

    const described = resolvePushAdapter().describe();
    const queued = await ctx.db
      .query("pushNotifications")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .take(200);

    return { ...described, queued: queued.length };
  },
});
