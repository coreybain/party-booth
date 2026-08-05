import {
  AUDIT_ACTIONS,
  createEventInputSchema,
  DENIAL_MESSAGES,
  eventStateMachine,
  explainCan,
  InvalidTransitionError,
  isHostSettableEventState,
  isJoinableEventState,
  setActiveEventInputSchema,
  setEventNowInputSchema,
  setEventStateInputSchema,
  updateEventInputSchema,
  type EventState,
  type Role,
} from "@partybooth/contracts";
import { serverEnv } from "@partybooth/env/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { writeAuditEvent, writeEventAudit } from "./lib/audit";
import { ACCOUNT_DELETION_GRACE_MS } from "./lib/account_deletion";
import { isAdminEmail } from "./lib/config";
import { forbidden, invalidState, notFound } from "./lib/errors";
import { ensureCodeIsFree, getActiveInviteVersion, mintInviteVersion } from "./lib/events";
import {
  getActiveMembership,
  requireActiveUser,
  requireEventActor,
  requirePermission,
  requireUser,
  toPermissionActor,
  type EventActor,
} from "./lib/guards";
import { parseInput } from "./lib/input";
import { eventIsUsable } from "./lib/lock";
import { notifyEventLifecycle } from "./lib/notifications";
import { expireGrantsForEvent } from "./lib/upload_grants";
import { eventState, moderationMode, storageRegion } from "./lib/validators";

/**
 * Event CRUD and the event state machine.
 *
 * Three rules hold across every mutation in this file:
 *
 * 1. **Permission first, then state.** `requireEventActor` resolves the role
 *    (and hides the event behind `notFound` from anyone with no relationship to
 *    it), then `requirePermission` asks `@partybooth/contracts`. No policy is
 *    decided here — this file only picks which question to ask.
 * 2. **The state machine is the contract's.** `eventStateMachine.assertTransition`
 *    is the only thing that decides whether a move is legal, so the console, the
 *    app and the backend cannot disagree about whether `archived → live` is a
 *    thing (it is: the after-party).
 * 3. **Every state change is audited.** Not analytics — audit. Who re-opened
 *    the party at 2am is a question that gets asked afterwards.
 */

/* -------------------------------------------------------------------------- */
/* Shapes returned to clients                                                 */
/* -------------------------------------------------------------------------- */

const eventSummaryFields = {
  id: v.id("events"),
  name: v.string(),
  state: eventState,
  moderationMode,
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  timeZone: v.string(),
  accentColor: v.optional(v.string()),
  coverKey: v.optional(v.string()),
  allowLibraryImport: v.boolean(),
  publicGalleryEnabled: v.boolean(),
  storageRegion,
  /** The caller's role for this event, so a client can pick its shell. */
  role: v.union(v.literal("owner"), v.literal("cohost"), v.literal("guest")),
  counts: v.object({
    pending: v.number(),
    approved: v.number(),
    declined: v.number(),
    total: v.number(),
  }),
};

const eventSummaryValidator = v.object(eventSummaryFields);

type EventSummary = {
  id: Id<"events">;
  name: string;
  state: EventState;
  moderationMode: Doc<"events">["moderationMode"];
  startsAt: number;
  endsAt?: number;
  timeZone: string;
  accentColor?: string;
  coverKey?: string;
  allowLibraryImport: boolean;
  publicGalleryEnabled: boolean;
  storageRegion: Doc<"events">["storageRegion"];
  role: "owner" | "cohost" | "guest";
  counts: Doc<"events">["counts"];
};

function toSummary(event: Doc<"events">, role: "owner" | "cohost" | "guest"): EventSummary {
  return {
    id: event._id,
    name: event.name,
    state: event.state,
    moderationMode: event.moderationMode,
    startsAt: event.startsAt,
    ...(event.endsAt === undefined ? {} : { endsAt: event.endsAt }),
    timeZone: event.timeZone,
    ...(event.accentColor === undefined ? {} : { accentColor: event.accentColor }),
    ...(event.coverKey === undefined ? {} : { coverKey: event.coverKey }),
    allowLibraryImport: event.allowLibraryImport,
    publicGalleryEnabled: event.publicGalleryEnabled ?? false,
    storageRegion: event.storageRegion,
    role,
    counts: event.counts,
  };
}

/**
 * The role to use for a permission check that has no event in it.
 *
 * Event creation has no event membership from which to derive a role. Ordinary
 * accounts use `guest` and must have an organiser invitation; an email on the
 * global-admin allowlist uses `globalAdmin` and is exempt from that beta gate.
 */
function platformRoleFor(user: Pick<Doc<"users">, "email">): Role {
  return isAdminEmail(user.email) ? "globalAdmin" : "guest";
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export const create = mutation({
  args: {
    name: v.string(),
    schedule: v.object({
      startsAt: v.number(),
      endsAt: v.optional(v.number()),
      timeZone: v.string(),
    }),
    moderationMode: v.optional(v.union(v.literal("manual"), v.literal("automatic"))),
    accentColor: v.optional(v.string()),
    coverKey: v.optional(v.string()),
    storageRegion: v.optional(storageRegion),
    allowLibraryImport: v.optional(v.boolean()),
    initialState: v.optional(v.union(v.literal("draft"), v.literal("scheduled"))),
  },
  returns: v.object({
    eventId: v.id("events"),
    inviteVersionId: v.id("inviteVersions"),
    code: v.string(),
    token: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);

    // Private beta is invitation-only for ordinary accounts. `isOrganiser` is
    // set by verified-email matching against an accepted organiser invitation;
    // the configured global-admin allowlist is the only exception.
    //
    // `explainCan` rather than `requirePermission` for one reason: the contract
    // is still the only thing deciding, but "not available right now" is the
    // wrong sentence for "you have not been invited to the beta", and that is
    // the single most likely refusal an early user will see.
    const decision = explainCan(
      toPermissionActor(user, platformRoleFor(user)),
      "platform.createEvent",
      {
        kind: "platform",
        isOrganiser: user.isOrganiser,
      },
    );
    if (!decision.allowed) {
      throw forbidden(
        decision.reason === "resourceState"
          ? "PartyBooth is invitation-only during the beta. Ask the person who invited you for an organiser invitation."
          : DENIAL_MESSAGES[decision.reason],
      );
    }

    const input = parseInput(createEventInputSchema, args);
    const now = Date.now();

    const eventId = await ctx.db.insert("events", {
      ownerUserId: user._id,
      name: input.name,
      state: input.initialState,
      moderationMode: input.moderationMode,
      // No picker UI at launch; the column exists so P5 is a config change.
      storageRegion: input.storageRegion ?? serverEnv.STORAGE_DEFAULT_REGION,
      startsAt: input.schedule.startsAt,
      ...(input.schedule.endsAt === undefined ? {} : { endsAt: input.schedule.endsAt }),
      timeZone: input.schedule.timeZone,
      ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
      ...(input.coverKey === undefined ? {} : { coverKey: input.coverKey }),
      allowLibraryImport: input.allowLibraryImport,
      publicGalleryEnabled: false,
      counts: { pending: 0, approved: 0, declined: 0, total: 0 },
      createdAt: now,
      updatedAt: now,
    });

    const event = await ctx.db.get(eventId);
    if (!event) throw notFound("That event");

    // The owner gets a membership row like everyone else, so every permission
    // check, every member list and every revocation has exactly one shape.
    await ctx.db.insert("memberships", {
      eventId,
      userId: user._id,
      role: "owner",
      status: "active",
      joinedAt: now,
    });

    // The code and QR exist from the moment the event does. A host who creates
    // an event and immediately shows the QR is the common case, not an edge.
    const invite = await mintInviteVersion(ctx, {
      event,
      createdByUserId: user._id,
      keepExistingMemberships: true,
      now,
    });

    if (user.activeEventId === undefined) {
      await ctx.db.patch(user._id, { activeEventId: eventId, updatedAt: now });
    }

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventCreated,
      event,
      actor: { user, role: "owner" },
      metadata: { state: input.initialState, moderationMode: input.moderationMode },
      now,
    });

    return {
      eventId,
      inviteVersionId: invite.inviteVersionId,
      code: invite.code,
      token: invite.token,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Update                                                                     */
/* -------------------------------------------------------------------------- */

export const update = mutation({
  args: {
    eventId: v.id("events"),
    name: v.optional(v.string()),
    schedule: v.optional(
      v.object({
        startsAt: v.number(),
        endsAt: v.optional(v.number()),
        timeZone: v.string(),
      }),
    ),
    moderationMode: v.optional(v.union(v.literal("manual"), v.literal("automatic"))),
    accentColor: v.optional(v.string()),
    coverKey: v.optional(v.string()),
    allowLibraryImport: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(updateEventInputSchema, args);
    const permissionActor = toPermissionActor(actor.user, actor.role);
    const resource = { kind: "event", state: actor.event.state } as const;

    // Three separate capabilities, because a co-host may move the schedule but
    // may not rename the party or change how it is moderated. Each is only
    // demanded when that group of fields is actually being touched, so a
    // schedule-only edit from a co-host is not refused for the settings it did
    // not send.
    const touchesSettings =
      input.name !== undefined ||
      input.accentColor !== undefined ||
      input.coverKey !== undefined ||
      input.allowLibraryImport !== undefined;

    if (touchesSettings) requirePermission(permissionActor, "event.update", resource);
    if (input.schedule !== undefined) {
      requirePermission(permissionActor, "event.updateSchedule", resource);
    }
    if (input.moderationMode !== undefined) {
      requirePermission(permissionActor, "event.changeModerationMode", resource);
    }

    const now = Date.now();
    const changed: string[] = [];

    const patch: Partial<Doc<"events">> = { updatedAt: now };
    if (input.name !== undefined) {
      patch.name = input.name;
      changed.push("name");
    }
    if (input.schedule !== undefined) {
      patch.startsAt = input.schedule.startsAt;
      patch.endsAt = input.schedule.endsAt;
      patch.timeZone = input.schedule.timeZone;
      changed.push("schedule");
    }
    if (input.moderationMode !== undefined) {
      patch.moderationMode = input.moderationMode;
      changed.push("moderationMode");
    }
    if (input.accentColor !== undefined) {
      patch.accentColor = input.accentColor;
      changed.push("accentColor");
    }
    if (input.coverKey !== undefined) {
      patch.coverKey = input.coverKey;
      changed.push("coverKey");
    }
    if (input.allowLibraryImport !== undefined) {
      patch.allowLibraryImport = input.allowLibraryImport;
      changed.push("allowLibraryImport");
    }

    if (changed.length === 0) return null;

    await ctx.db.patch(actor.event._id, patch);

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventUpdated,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      // Field *names* only. The values are the party's business.
      metadata: { fields: changed },
      now,
    });

    return null;
  },
});

/**
 * Publish or close the post-event gallery reached from the current QR.
 *
 * This is deliberately separate from `update`: ordinary event settings freeze
 * when an event is archived, while the owner must be able to turn public photo
 * access off after the party. The setting never makes pending or declined
 * submissions public; the read path is hard-filtered to `approved` media.
 */
export const setPublicGallery = mutation({
  args: { eventId: v.id("events"), enabled: v.boolean() },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    requirePermission(toPermissionActor(actor.user, actor.role), "event.managePublicGallery", {
      kind: "event",
      state: actor.event.state,
    });

    const enabled = args.enabled;
    if ((actor.event.publicGalleryEnabled ?? false) === enabled) return { enabled };

    const now = Date.now();
    await ctx.db.patch(actor.event._id, { publicGalleryEnabled: enabled, updatedAt: now });
    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventUpdated,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      metadata: { fields: ["publicGalleryEnabled"] },
      now,
    });
    return { enabled };
  },
});

/* -------------------------------------------------------------------------- */
/* State machine                                                              */
/* -------------------------------------------------------------------------- */

interface StateTransitionOptions {
  readonly actor: EventActor;
  readonly to: EventState;
  readonly now: number;
  readonly reason?: string;
  readonly schedulePatch?: {
    readonly startsAt?: number;
    readonly endsAt?: number | undefined;
  };
}

async function transitionEventState(
  ctx: MutationCtx,
  { actor, to, now, reason, schedulePatch }: StateTransitionOptions,
): Promise<{ state: EventState; reissuedCode?: string }> {
  // A host on their way out of the product must not keep opening and closing
  // parties. `requireEventActor` resolves through `requireUser`, deliberately,
  // so this is checked here or not at all — the same shape as `moderate`.
  if (actor.user.accountState !== "active") {
    throw forbidden("This account cannot change the event right now.");
  }

  requirePermission(toPermissionActor(actor.user, actor.role), "event.changeState", {
    kind: "event",
    state: actor.event.state,
  });

  /*
   * Archiving is a second, narrower capability.
   *
   * `event.changeState` moves an event between `live` and `paused`, which is a
   * co-host's job during a party — PLAN.md's pressure valve. Ending the party
   * is not: `event.archive` is owner and admin only.
   */
  if (to === "archived") {
    requirePermission(toPermissionActor(actor.user, actor.role), "event.archive", {
      kind: "event",
      state: actor.event.state,
    });
  }

  // Belt and braces: the mutation validators already exclude it, and the
  // contract's `HOST_SETTABLE_EVENT_STATES` is the reason why. Reaching
  // `deletionScheduled` has to go through the deletion flow.
  if (!isHostSettableEventState(to)) {
    throw forbidden("Deleting an event is done from the deletion flow, not the state switch.");
  }

  const from = actor.event.state;
  if (from === to && schedulePatch === undefined) return { state: to };

  if (from !== to) {
    try {
      eventStateMachine.assertTransition(from, to);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw invalidState(error.message);
      throw error;
    }
  }

  await ctx.db.patch(actor.event._id, {
    state: to,
    ...schedulePatch,
    ...(to === "archived" ? { archivedAt: now } : {}),
    updatedAt: now,
  });

  if (schedulePatch !== undefined) {
    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventUpdated,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      metadata: { fields: ["schedule"] },
      now,
    });
  }

  // Codes are unique among *joinable* events, so archiving frees one
  // implicitly. Coming back the other way is therefore the one transition
  // that can find its own code already taken — and the fix is a *new* invite
  // version, not an edit to the old row, which memberships point at.
  let reissuedCode: string | undefined;
  let reissuedVersion: number | undefined;
  if (!isJoinableEventState(from) && isJoinableEventState(to)) {
    const fresh = await ctx.db.get(actor.event._id);
    const reissued = fresh
      ? await ensureCodeIsFree(ctx, fresh, {
          now,
          actorUserId: actor.user._id,
          ...(reason === undefined ? {} : { reason }),
        })
      : undefined;
    reissuedCode = reissued?.reissuedCode;
    reissuedVersion = reissued?.version;
  }

  if (from !== to) {
    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventStateChanged,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      reason,
      metadata: {
        from,
        to,
        ...(reissuedCode === undefined
          ? {}
          : { codeReissued: true, inviteVersion: reissuedVersion }),
      },
      now,
    });
  }

  /*
   * "Event opened / closed" — PLAN.md's second push trigger. Deriving it from
   * the transition pair stops draft → scheduled from notifying guests and
   * makes paused → live an opening. Notification failure cannot fail the state
   * change; see `lib/notifications.ts`.
   */
  const opened = to === "live" && from !== "live";
  const closed = from === "live" && to !== "live";
  if (opened || closed) {
    const fresh = await ctx.db.get(actor.event._id);
    if (fresh) {
      await notifyEventLifecycle(ctx, {
        event: fresh,
        transition: opened ? "opened" : "closed",
        actorUserId: actor.user._id,
        now,
      });
    }
  }

  return { state: to, ...(reissuedCode === undefined ? {} : { reissuedCode }) };
}

export const setState = mutation({
  args: {
    eventId: v.id("events"),
    state: v.union(
      v.literal("draft"),
      v.literal("scheduled"),
      v.literal("live"),
      v.literal("paused"),
      v.literal("archived"),
    ),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    state: eventState,
    /** Set when re-opening forced a fresh code — the printed one is dead. */
    reissuedCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(setEventStateInputSchema, args);
    return await transitionEventState(ctx, {
      actor,
      to: input.state,
      now: Date.now(),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  },
});

/**
 * Stamp a schedule boundary and change the live state in one transaction.
 *
 * This is intentionally different from Publish/Unpublish: those state-only
 * controls respect the schedule the host configured, while these actions mean
 * "the party starts/ends at this exact server time".
 */
export const setNow = mutation({
  args: {
    eventId: v.id("events"),
    action: v.union(v.literal("start"), v.literal("end")),
  },
  returns: v.object({
    state: eventState,
    reissuedCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(setEventNowInputSchema, args);

    requirePermission(toPermissionActor(actor.user, actor.role), "event.updateSchedule", {
      kind: "event",
      state: actor.event.state,
    });

    const now = Date.now();
    if (input.action === "start") {
      // A live event can still be published ahead of its scheduled start. In
      // that case Start now has real work to do: stamp the boundary without a
      // redundant state transition. Once the start has passed it is a no-op.
      if (actor.event.state === "live" && actor.event.startsAt <= now) {
        return { state: actor.event.state };
      }

      return await transitionEventState(ctx, {
        actor,
        to: "live",
        now,
        schedulePatch: {
          startsAt: now,
          // A previously-ended event needs an open-ended schedule when it is
          // restarted; a future end remains the host's intended boundary.
          ...(actor.event.endsAt !== undefined && actor.event.endsAt <= now
            ? { endsAt: undefined }
            : {}),
        },
      });
    }

    if (actor.event.state === "paused") return { state: actor.event.state };

    return await transitionEventState(ctx, {
      actor,
      to: "paused",
      now,
      schedulePatch: {
        // A live state can be published ahead of its schedule. Keep the strict
        // endsAt > startsAt invariant when ending that unusual event now.
        ...(actor.event.startsAt >= now ? { startsAt: now - 1 } : {}),
        endsAt: now,
      },
    });
  },
});

/**
 * Let an owner remove their own event from the product.
 *
 * "Delete" enters the same thirty-day deletion lifecycle used by the admin
 * console instead of trying to synchronously erase a party and every guest's
 * media from a menu click. Access ends immediately through the event state, all
 * outstanding upload grants are expired, and the scheduled job is what makes
 * the eventual purge auditable.
 */
export const requestDeletion = mutation({
  args: { eventId: v.id("events") },
  returns: v.object({ state: eventState, scheduledAt: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);

    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot delete the event right now.");
    }

    requirePermission(toPermissionActor(actor.user, actor.role), "event.delete", {
      kind: "event",
      state: actor.event.state,
    });
    requirePermission(toPermissionActor(actor.user, actor.role), "event.scheduleDeletion", {
      kind: "event",
      state: actor.event.state,
    });

    try {
      eventStateMachine.assertTransition(actor.event.state, "deletionScheduled");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw invalidState(error.message);
      throw error;
    }

    const now = Date.now();
    const scheduledAt = now + ACCOUNT_DELETION_GRACE_MS;
    const reason = "Requested by the event owner.";
    const expiredGrants = await expireGrantsForEvent(ctx, actor.event._id, now);

    await ctx.db.patch(actor.event._id, {
      state: "deletionScheduled",
      deletionScheduledAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("deletionJobs", {
      subjectType: "event",
      subjectId: actor.event._id,
      state: "scheduled",
      scheduledAt,
      requestedByUserId: actor.user._id,
      reason,
      createdAt: now,
    });

    if (actor.user.activeEventId === actor.event._id) {
      await ctx.db.patch(actor.user._id, { activeEventId: undefined, updatedAt: now });
    }

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventDeletionScheduled,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      reason,
      metadata: { previousState: actor.event.state, scheduledAt, expiredGrants },
      now,
    });

    if (actor.event.state === "live") {
      const fresh = await ctx.db.get(actor.event._id);
      if (fresh) {
        await notifyEventLifecycle(ctx, {
          event: fresh,
          transition: "closed",
          actorUserId: actor.user._id,
          now,
        });
      }
    }

    return { state: "deletionScheduled" as const, scheduledAt };
  },
});

/* -------------------------------------------------------------------------- */
/* Active event                                                               */
/* -------------------------------------------------------------------------- */

export const setActiveEvent = mutation({
  args: { eventId: v.union(v.id("events"), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    parseInput(setActiveEventInputSchema, args);

    if (args.eventId === null) {
      await ctx.db.patch(user._id, { activeEventId: undefined, updatedAt: Date.now() });
      return null;
    }

    // `requireEventActor` throws `notFound` for a stranger, which is also the
    // right answer here: you cannot point your camera at a party you are not at.
    await requireEventActor(ctx, args.eventId);
    await ctx.db.patch(user._id, { activeEventId: args.eventId, updatedAt: Date.now() });
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/* Leaving                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Walk out of a party you were a guest (or co-host) at.
 *
 * The membership goes to `"left"`, not away: `join.ts` re-activates a left row
 * on a fresh scan of a valid code, so leaving is always reversible by the same
 * door the guest came in through. Nothing they uploaded is touched — withdrawal
 * of individual items is "My media"'s job, and conflating the two would make
 * "leave" quietly destructive.
 *
 * The owner is refused. An event whose owner has left is a party nobody can
 * moderate, rotate or close; the owner's exit is `events.requestDeletion`.
 *
 * `requireUser` rather than `requireActiveUser`, deliberately: leaving shrinks
 * the account's footprint, and a locked account must still be able to walk out
 * of a party — the same reasoning that lets it request deletion.
 */
export const leave = mutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    const membership = await getActiveMembership(ctx, args.eventId, user._id);
    const event = await ctx.db.get(args.eventId);
    // A stranger asking to leave gets the same answer as a stranger asking to
    // look: this party does not exist for you.
    if (!membership || !event) throw notFound("That party");

    if (event.ownerUserId === user._id) {
      throw forbidden(
        "You are the host — a party can't be left by the person running it. Delete the party instead.",
      );
    }

    const now = Date.now();
    await ctx.db.patch(membership._id, { status: "left" });
    // The camera must not stay pointed at a party its owner just walked out of.
    if (user.activeEventId === args.eventId) {
      await ctx.db.patch(user._id, { activeEventId: undefined, updatedAt: now });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipLeft,
      subjectType: "membership",
      subjectId: membership._id,
      actor: { userId: user._id, role: membership.role },
      eventId: args.eventId,
      metadata: { role: membership.role },
      now,
    });
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every event the signed-in user can walk into, newest first.
 *
 * Built from `memberships` rather than from `events`, because the owner has a
 * membership too — so one index scan covers hosting and attending alike, and
 * there is no second code path to forget about.
 */
export const myEvents = query({
  args: {},
  returns: v.array(eventSummaryValidator),
  handler: async (ctx) => {
    const user = await requireUser(ctx);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_status", (q) => q.eq("userId", user._id).eq("status", "active"))
      .collect();

    const summaries: EventSummary[] = [];
    for (const membership of memberships) {
      const event = await ctx.db.get(membership.eventId);
      if (!event) continue;
      // An event on its way out is not on anybody's list.
      if (event.state === "deletionScheduled") continue;
      // Nor is one whose owner has been locked. `requireEventActor` already
      // refuses every read and write inside it (see `lib/lock.ts`); leaving it
      // on the list would offer a co-host a party that answers "suspended" to
      // every tap, which is a worse experience than it simply not being there.
      if (!(await eventIsUsable(ctx, event))) continue;
      summaries.push(toSummary(event, event.ownerUserId === user._id ? "owner" : membership.role));
    }

    return summaries.sort((a, b) => b.startsAt - a.startsAt);
  },
});

/**
 * The event this user's camera is pointed at.
 *
 * Falls back to the most recent membership when nothing is selected, and
 * self-heals when the stored selection has gone stale — an event that was
 * archived, or a membership that was revoked by a rotation, must not leave the
 * app stuck on a party it cannot use. A query cannot write, so the stale value
 * is ignored rather than cleared; `setActiveEvent` does the tidying.
 */
export const activeEvent = query({
  args: {},
  returns: v.union(v.null(), eventSummaryValidator),
  handler: async (ctx) => {
    const user = await requireUser(ctx);

    if (user.activeEventId) {
      const event = await ctx.db.get(user.activeEventId);
      if (event && event.state !== "deletionScheduled" && (await eventIsUsable(ctx, event))) {
        const membership = await getActiveMembership(ctx, event._id, user._id);
        if (membership) {
          return toSummary(event, event.ownerUserId === user._id ? "owner" : membership.role);
        }
      }
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_status", (q) => q.eq("userId", user._id).eq("status", "active"))
      .collect();

    let best: EventSummary | null = null;
    for (const membership of memberships) {
      const event = await ctx.db.get(membership.eventId);
      if (!event || event.state === "deletionScheduled") continue;
      if (!(await eventIsUsable(ctx, event))) continue;
      const summary = toSummary(event, event.ownerUserId === user._id ? "owner" : membership.role);
      if (best === null || summary.startsAt > best.startsAt) best = summary;
    }
    return best;
  },
});

/**
 * The event home screen.
 *
 * The join code and QR token are **host-only**. A guest holding them could
 * re-share the party to anyone, which is exactly what invite rotation exists to
 * undo — so they are omitted from the payload rather than hidden in the UI.
 */
export const home = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    event: eventSummaryValidator,
    isHost: v.boolean(),
    memberCount: v.number(),
    invite: v.optional(
      v.object({
        version: v.number(),
        code: v.string(),
        /** Absent for a global admin — see the note below and `invites.current`. */
        token: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "event.view", {
      kind: "event",
      state: actor.event.state,
    });

    const role: "owner" | "cohost" | "guest" = actor.role === "globalAdmin" ? "guest" : actor.role;
    const isHost = actor.role === "owner" || actor.role === "cohost";

    const members = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_status", (q) =>
        q.eq("eventId", actor.event._id).eq("status", "active"),
      )
      .collect();

    // Admins get the code because `event.viewInviteCode` is in their capability
    // set — rotating a code from the admin console needs to show which one it
    // is replacing — but they are not `isHost`, so they get no host UI. The
    // durable QR token is unnecessary for that support workflow and is omitted.
    const maySeeCode = canSeeInviteCode(actor.role, actor.event.state, actor.user.accountState);
    const invite = maySeeCode ? await getActiveInviteVersion(ctx, actor.event) : null;

    return {
      event: toSummary(actor.event, role),
      isHost,
      memberCount: members.length,
      ...(invite === null
        ? {}
        : {
            invite: {
              version: invite.version,
              code: invite.code,
              ...(actor.role === "globalAdmin" ? {} : { token: invite.token }),
            },
          }),
    };
  },
});

function canSeeInviteCode(
  role: Role,
  state: EventState,
  accountState: Doc<"users">["accountState"],
): boolean {
  // Reuse the contract rather than re-deriving it: `event.viewInviteCode` is
  // granted to owner, cohost and globalAdmin, and gated on an editable state.
  const actor = { role, accountState };
  try {
    requirePermission(actor, "event.viewInviteCode", { kind: "event", state });
    return true;
  } catch {
    return false;
  }
}
