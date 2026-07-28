import {
  accountStateMachine,
  adminAccountActionInputSchema,
  adminEventActionInputSchema,
  adminListInputSchema,
  adminRevokeMembershipInputSchema,
  adminRotateCodeInputSchema,
  AUDIT_ACTIONS,
  eventStateMachine,
  generateSecret,
  inviteOrganiserInputSchema,
  InvalidTransitionError,
  normalizeEventCode,
  ROTATION_THROTTLED_MESSAGE,
  validateSpecificEventCode,
} from "@partybooth/contracts";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { scheduleAccountDeletion, ACCOUNT_DELETION_GRACE_MS } from "./lib/account-deletion";
import { writeAuditEvent, writeEventAudit } from "./lib/audit";
import { isAdminEmail, siteUrl } from "./lib/config";
import { organiserInviteEmail, sendEmail } from "./lib/email";
import {
  forbidden,
  invalidInput,
  invalidState,
  notConfigured,
  notFound,
  rateLimited,
} from "./lib/errors";
import { getActiveInviteVersion, isCodeTaken, mintInviteVersion } from "./lib/events";
import { requireGlobalAdmin, requirePermission, toPermissionActor } from "./lib/guards";
import { parseInput } from "./lib/input";
import { storedBytesOf } from "./lib/media";
import { checkRotationThrottle, recordRotation } from "./lib/rotation-throttle";
import {
  expireGrantsForAccount,
  expireGrantsForEvent,
  expireGrantsForUser,
} from "./lib/upload-grants";
import { accountState, eventState } from "./lib/validators";

/**
 * The `/admin` console, server side.
 *
 * PLAN.md keeps this in launch scope "at your insistence", and attaches three
 * rules to it that are enforced here rather than in the console's forms,
 * because a rule enforced in a form is a rule a `curl` does not have:
 *
 * 1. **Allowlist-gated.** Every function starts with `requireGlobalAdmin`, which
 *    consults `ADMIN_EMAIL_ALLOWLIST` — the environment, not
 *    `users.isGlobalAdmin`, which is a cache. A write into the `users` table
 *    still cannot mint an admin.
 * 2. **Every mutation carries a non-empty reason.** `adminReasonSchema` refuses
 *    a blank one on the way in, and `writeAuditEvent` throws rather than writing
 *    a row without one for every action on `AUDIT_ACTIONS_REQUIRING_REASON` —
 *    which, since Sprint 5, is every action this file performs.
 * 3. **No media access.** Nothing in this file mints a signed URL, and nothing
 *    in it returns a storage key. `CAPABILITIES` gives `globalAdmin` no `media.*`
 *    action at all, `canSeeMedia` refuses them every row, `stats.overview`
 *    withholds the contributor breakdown from them, and since Sprint 5
 *    `projectMedia` refuses to mint a URL for the role outright. The console
 *    counts assets and bytes; it never looks at photographs.
 *
 * ## What "delete" means here
 *
 * Nothing in this file destroys anything. Account and event deletion are
 * **scheduled** — a state change plus a `deletionJobs` row thirty days out — and
 * `convex/deletion.ts` is what eventually erases. That gap is the restore
 * window, and it is why `restoreAccount` and `restoreEvent` exist at all.
 */

/** Same cast as `emails.ts`: the generic `AnyApi` fallback until codegen runs. */
type OrganiserInviteResult = {
  invitationId: Id<"organiserInvitations">;
  token: string;
  invitedByName: string;
  expiresInDays: number;
};

const adminFunctions = internal.admin as unknown as {
  createOrganiserInvitation: FunctionReference<
    "mutation",
    "internal",
    { authId: string; email: string; note?: string; reason: string },
    OrganiserInviteResult
  >;
};

/** How long an organiser invitation stays open. */
export const ORGANISER_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

const accountRowValidator = v.object({
  id: v.id("users"),
  email: v.string(),
  displayName: v.string(),
  accountState,
  isOrganiser: v.boolean(),
  isGlobalAdmin: v.boolean(),
  emailVerified: v.boolean(),
  /** Events this account owns, excluding ones already queued for deletion. */
  ownedEvents: v.number(),
  /** Parties they are in as a guest or co-host. */
  memberships: v.number(),
  /** Bytes their submissions occupy, originals and derivatives. Approximate. */
  storageBytes: v.number(),
  mediaCount: v.number(),
  pushDevices: v.number(),
  lockedAt: v.optional(v.number()),
  lockReason: v.optional(v.string()),
  deletionScheduledAt: v.optional(v.number()),
  createdAt: v.number(),
});

/**
 * Accounts, with the three columns PLAN.md names: state, roles, storage usage.
 *
 * Deliberately a full scan with an in-memory filter rather than a search index:
 * the private beta is measured in dozens of accounts, a search index is a
 * schema-level commitment, and the console is not on any hot path. When this
 * stops being true the fix is an index, not a rewrite.
 */
export const accounts = query({
  args: { search: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ total: v.number(), items: v.array(accountRowValidator) }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminListInputSchema, args);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "platform.viewAccounts", {
      kind: "platform",
      isOrganiser: admin.isOrganiser,
    });

    const users = await ctx.db.query("users").collect();
    const needle = input.search?.toLowerCase();
    const matched = users.filter(
      (user) =>
        needle === undefined ||
        user.email.toLowerCase().includes(needle) ||
        user.displayName.toLowerCase().includes(needle),
    );

    const page = matched.sort((a, b) => b.createdAt - a.createdAt).slice(0, input.limit ?? 50);

    const items = [];
    for (const user of page) {
      const owned = await ctx.db
        .query("events")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
        .collect();
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_status", (q) => q.eq("userId", user._id).eq("status", "active"))
        .collect();
      const media = await ctx.db
        .query("media")
        .withIndex("by_uploader", (q) => q.eq("uploaderUserId", user._id))
        .collect();
      const devices = await ctx.db
        .query("pushDevices")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();

      const live = media.filter((row) => row.state !== "deleted");

      items.push({
        id: user._id,
        email: user.email,
        displayName: user.displayName,
        accountState: user.accountState,
        isOrganiser: user.isOrganiser,
        isGlobalAdmin: user.isGlobalAdmin,
        emailVerified: user.emailVerified,
        ownedEvents: owned.filter((event) => event.state !== "deletionScheduled").length,
        memberships: memberships.length,
        storageBytes: live.reduce((sum, row) => sum + storedBytesOf(row), 0),
        mediaCount: live.length,
        pushDevices: devices.filter((device) => device.disabledAt === undefined).length,
        ...(user.lockedAt === undefined ? {} : { lockedAt: user.lockedAt }),
        ...(user.lockReason === undefined ? {} : { lockReason: user.lockReason }),
        ...(user.deletionScheduledAt === undefined
          ? {}
          : { deletionScheduledAt: user.deletionScheduledAt }),
        createdAt: user.createdAt,
      });
    }

    return { total: matched.length, items };
  },
});

const eventRowValidator = v.object({
  id: v.id("events"),
  name: v.string(),
  state: eventState,
  ownerUserId: v.id("users"),
  ownerDisplayName: v.string(),
  /** `true` when the owner's account state has frozen the whole party. */
  frozen: v.boolean(),
  counts: v.object({
    pending: v.number(),
    approved: v.number(),
    declined: v.number(),
    total: v.number(),
  }),
  processing: v.number(),
  assetCount: v.number(),
  storageBytes: v.number(),
  memberCount: v.number(),
  /** Rows tombstoned whose objects are still in storage. See `media.stuckPurges`. */
  stuckPurges: v.number(),
  inviteVersion: v.optional(v.number()),
  startsAt: v.number(),
  deletionScheduledAt: v.optional(v.number()),
  createdAt: v.number(),
});

/**
 * Events, with asset counts, status totals and per-event job health.
 *
 * The join code is **not** in this shape. `event.viewInviteCode` is in the admin
 * capability set so the rotation form can show which number it is replacing, and
 * that is what `events.home` serves — one event, deliberately asked for. A list
 * view that carried every live code would turn one console session into every
 * party in the product.
 */
export const events = query({
  args: { search: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ total: v.number(), items: v.array(eventRowValidator) }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminListInputSchema, args);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "platform.viewAdminConsole", {
      kind: "platform",
      isOrganiser: admin.isOrganiser,
    });

    const rows = await ctx.db.query("events").collect();
    const needle = input.search?.toLowerCase();
    const matched = rows.filter(
      (event) => needle === undefined || event.name.toLowerCase().includes(needle),
    );

    const page = matched.sort((a, b) => b.createdAt - a.createdAt).slice(0, input.limit ?? 50);

    const items = [];
    for (const event of page) {
      const owner = await ctx.db.get(event.ownerUserId);
      const media = await ctx.db
        .query("media")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_event_and_status", (q) => q.eq("eventId", event._id).eq("status", "active"))
        .collect();
      const invite = await getActiveInviteVersion(ctx, event);

      const live = media.filter((row) => row.state !== "deleted");

      items.push({
        id: event._id,
        name: event.name,
        state: event.state,
        ownerUserId: event.ownerUserId,
        ownerDisplayName: owner?.displayName ?? "Unknown",
        frozen: owner === null || owner.accountState !== "active",
        counts: event.counts,
        processing: live.filter((row) => row.state === "processing").length,
        assetCount: live.length,
        storageBytes: live.reduce((sum, row) => sum + storedBytesOf(row), 0),
        memberCount: members.length,
        stuckPurges: media.filter(
          (row) => row.deletedAt !== undefined && row.storageDeletedAt === undefined,
        ).length,
        ...(invite === null ? {} : { inviteVersion: invite.version }),
        startsAt: event.startsAt,
        ...(event.deletionScheduledAt === undefined
          ? {}
          : { deletionScheduledAt: event.deletionScheduledAt }),
        createdAt: event.createdAt,
      });
    }

    return { total: matched.length, items };
  },
});

/**
 * Job health: the things that are supposed to happen by themselves and have not.
 *
 * `pendingExports` is a **placeholder and reads zero**, deliberately. ZIP exports
 * are P2 (PLAN.md defers Trigger.dev to post-launch) and there is no export job
 * table to count. Shipping the field now with an honest zero means the console
 * has the column and the dashboard has the shape; inventing a number would be
 * worse than either.
 */
export const jobHealth = query({
  args: {},
  returns: v.object({
    stuckPurges: v.number(),
    deletionJobs: v.object({
      scheduled: v.number(),
      due: v.number(),
      running: v.number(),
      failed: v.number(),
    }),
    /** Always 0 at launch — export jobs are P2. See the note above. */
    pendingExports: v.number(),
    pushQueue: v.object({ queued: v.number(), failed: v.number() }),
    disabledPushDevices: v.number(),
  }),
  handler: async (ctx) => {
    const admin = await requireGlobalAdmin(ctx);
    requirePermission(toPermissionActor(admin, "globalAdmin"), "platform.viewAdminConsole", {
      kind: "platform",
      isOrganiser: admin.isOrganiser,
    });

    const now = Date.now();

    const deleted = await ctx.db
      .query("media")
      .withIndex("by_state", (q) => q.eq("state", "deleted"))
      .collect();

    const jobs = await ctx.db.query("deletionJobs").collect();
    const scheduled = jobs.filter((job) => job.state === "scheduled");

    const queuedPush = await ctx.db
      .query("pushNotifications")
      .withIndex("by_state", (q) => q.eq("state", "queued"))
      .take(500);
    const failedPush = await ctx.db
      .query("pushNotifications")
      .withIndex("by_state", (q) => q.eq("state", "failed"))
      .take(500);

    const devices = await ctx.db.query("pushDevices").collect();

    return {
      stuckPurges: deleted.filter(
        (row) => row.deletedAt !== undefined && row.storageDeletedAt === undefined,
      ).length,
      deletionJobs: {
        scheduled: scheduled.length,
        // Past its date and still not run — the one that means the cron is stuck.
        due: scheduled.filter((job) => job.scheduledAt <= now).length,
        running: jobs.filter((job) => job.state === "running").length,
        failed: jobs.filter((job) => job.state === "failed").length,
      },
      pendingExports: 0,
      pushQueue: { queued: queuedPush.length, failed: failedPush.length },
      disabledPushDevices: devices.filter((device) => device.disabledAt !== undefined).length,
    };
  },
});

/** The audit log, newest first — the console's record of itself. */
export const auditLog = query({
  args: {
    limit: v.optional(v.number()),
    eventId: v.optional(v.id("events")),
    actorUserId: v.optional(v.id("users")),
  },
  returns: v.array(
    v.object({
      id: v.id("auditEvents"),
      action: v.string(),
      subjectType: v.string(),
      subjectId: v.optional(v.string()),
      actorUserId: v.optional(v.id("users")),
      actorDisplayName: v.optional(v.string()),
      actorRole: v.optional(v.string()),
      eventId: v.optional(v.id("events")),
      reason: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    requirePermission(toPermissionActor(admin, "globalAdmin"), "platform.viewAuditLog", {
      kind: "platform",
      isOrganiser: admin.isOrganiser,
    });

    const limit = Math.min(args.limit ?? 100, 500);

    const rows =
      args.eventId !== undefined
        ? await ctx.db
            .query("auditEvents")
            .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
            .order("desc")
            .take(limit)
        : args.actorUserId !== undefined
          ? await ctx.db
              .query("auditEvents")
              .withIndex("by_actor", (q) => q.eq("actorUserId", args.actorUserId))
              .order("desc")
              .take(limit)
          : await ctx.db.query("auditEvents").withIndex("by_createdAt").order("desc").take(limit);

    const out = [];
    for (const row of rows) {
      const actor = row.actorUserId === undefined ? null : await ctx.db.get(row.actorUserId);
      out.push({
        id: row._id,
        action: row.action,
        subjectType: row.subjectType,
        ...(row.subjectId === undefined ? {} : { subjectId: row.subjectId }),
        ...(row.actorUserId === undefined ? {} : { actorUserId: row.actorUserId }),
        ...(actor === null ? {} : { actorDisplayName: actor.displayName }),
        ...(row.actorRole === undefined ? {} : { actorRole: row.actorRole }),
        ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        createdAt: row.createdAt,
      });
    }
    return out;
  },
});

/* -------------------------------------------------------------------------- */
/* Organiser invitations                                                      */
/* -------------------------------------------------------------------------- */

export const createOrganiserInvitation = internalMutation({
  args: {
    authId: v.string(),
    email: v.string(),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.object({
    invitationId: v.id("organiserInvitations"),
    token: v.string(),
    invitedByName: v.string(),
    expiresInDays: v.number(),
  }),
  handler: async (ctx, args): Promise<OrganiserInviteResult> => {
    // Resolved from `authId` rather than `ctx.auth`, for the reason spelled out
    // in `cohosts.createInvitation`: this is reached through `runMutation` from
    // an action, and the gate must not be a property of whether Convex happens
    // to propagate the auth context across that hop.
    const admin = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!admin) throw forbidden();
    if (admin.accountState !== "active") throw forbidden();
    if (!isAllowlisted(admin)) throw forbidden();

    const input = parseInput(inviteOrganiserInputSchema, {
      email: args.email,
      ...(args.note === undefined ? {} : { note: args.note }),
      reason: args.reason,
    });
    const now = Date.now();

    const open = (
      await ctx.db
        .query("organiserInvitations")
        .withIndex("by_email_and_status", (q) => q.eq("email", input.email).eq("status", "pending"))
        .collect()
    ).at(0);

    // Re-inviting refreshes the expiry and keeps the token, so a link already in
    // somebody's inbox stays live rather than being silently killed by an admin
    // pressing the button twice.
    const token = open?.token ?? generateSecret(24);
    let invitationId: Id<"organiserInvitations">;

    if (open) {
      invitationId = open._id;
      await ctx.db.patch(open._id, { expiresAt: now + ORGANISER_INVITATION_TTL_MS });
    } else {
      invitationId = await ctx.db.insert("organiserInvitations", {
        email: input.email,
        token,
        status: "pending",
        invitedByUserId: admin._id,
        ...(input.note === undefined ? {} : { note: input.note }),
        expiresAt: now + ORGANISER_INVITATION_TTL_MS,
        createdAt: now,
      });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.organiserInvited,
      subjectType: "organiserInvitation",
      subjectId: invitationId,
      actor: { userId: admin._id, role: "globalAdmin" },
      reason: input.reason,
      // No address: an audit log read in bulk must not become a mailing list.
      metadata: { renewed: open !== undefined },
      now,
    });

    return {
      invitationId,
      token,
      invitedByName: admin.displayName,
      expiresInDays: Math.round(ORGANISER_INVITATION_TTL_MS / (24 * 60 * 60 * 1000)),
    };
  },
});

/**
 * Invite an organiser into the private beta.
 *
 * An action, because it emails. The invitation commits first and the message is
 * sent after — a Resend outage must not lose the invitation, and verified-email
 * matching honours the row the moment its owner signs in whether or not they
 * were ever told.
 */
export const inviteOrganiser = action({
  args: { email: v.string(), note: v.optional(v.string()), reason: v.string() },
  returns: v.object({ invitationId: v.id("organiserInvitations"), emailed: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ invitationId: Id<"organiserInvitations">; emailed: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw forbidden();

    const created = await ctx.runMutation(adminFunctions.createOrganiserInvitation, {
      authId: identity.subject,
      email: args.email,
      ...(args.note === undefined ? {} : { note: args.note }),
      reason: args.reason,
    });

    const message = organiserInviteEmail({
      inviteUrl: `${stripTrailingSlash(siteUrl())}/invite/organiser/${created.token}`,
      invitedByName: created.invitedByName,
      ...(args.note === undefined ? {} : { note: args.note }),
      expiresInDays: created.expiresInDays,
    });
    const result = await sendEmail({ ...message, to: args.email });
    if (!result.ok) throw notConfigured("Email delivery");

    return { invitationId: created.invitationId, emailed: true };
  },
});

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Suspend an account.
 *
 * The state change is the whole mechanism, and it is worth being precise about
 * how far it reaches. `accountStateAllows` reduces the locked account to
 * "view yourself" and "delete yourself"; `lib/lock.ts` freezes **every event
 * they own**, for everybody — co-hosts, guests, joiners, the slideshow, upload
 * grants and signed-URL issuance alike. That second half is what makes locking a
 * host at 1am an actual remedy rather than a note in a table, and it is checked
 * in `requireEventActor` and `join.ts` rather than written out here, because a
 * lock that has to enumerate a person's events is a lock that misses the one
 * they create afterwards.
 *
 * Outstanding upload grants are expired here, though, because those are the one
 * capability that outlives a permission check: `completeUpload` validates the
 * grant, not the membership and not the account state.
 *
 * Two sweeps, because "whose grant is it" and "whose party is it" are different
 * questions and the freeze needs both answered:
 *
 * - **Every grant this account holds**, in every event — including parties they
 *   are only a guest or a co-host in, which the per-event loop never reached.
 * - **Every grant anybody holds** for a party this account *owns*, because those
 *   parties are now frozen for everyone. This is the half that was missing: a
 *   guest whose grant was minted seconds before the lock could still land a file
 *   in a suspended party, move its counters and ping its hosts.
 *
 * `media.completeUpload` re-asks the freeze question at the moment bytes are
 * accepted as well, so the guarantee does not rest on this enumeration being
 * exhaustive.
 */
export const lockAccount = mutation({
  args: { userId: v.id("users"), reason: v.string() },
  returns: v.object({ accountState, ownedEventsFrozen: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminAccountActionInputSchema, args);

    const target = await requireTarget(ctx, args.userId);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "account.lock", {
      kind: "account",
      state: target.accountState,
      isSelf: target._id === admin._id,
    });

    assertAccountTransition(target.accountState, "locked");

    const now = Date.now();
    await ctx.db.patch(target._id, {
      accountState: "locked",
      lockedAt: now,
      lockedByUserId: admin._id,
      lockReason: input.reason,
      updatedAt: now,
    });

    let expiredGrants = await expireGrantsForAccount(ctx, target._id, now);

    const owned = await ctx.db
      .query("events")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", target._id))
      .collect();
    for (const event of owned) {
      expiredGrants += await expireGrantsForEvent(ctx, event._id, now);
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.accountLocked,
      subjectType: "user",
      subjectId: target._id,
      actor: { userId: admin._id, role: "globalAdmin" },
      reason: input.reason,
      metadata: { previousState: "active", ownedEvents: owned.length, expiredGrants },
      now,
    });

    return { accountState: "locked" as const, ownedEventsFrozen: owned.length };
  },
});

export const unlockAccount = mutation({
  args: { userId: v.id("users"), reason: v.string() },
  returns: v.object({ accountState }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminAccountActionInputSchema, args);
    const target = await requireTarget(ctx, args.userId);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "account.unlock", {
      kind: "account",
      state: target.accountState,
      isSelf: target._id === admin._id,
    });

    assertAccountTransition(target.accountState, "active");

    const now = Date.now();
    await ctx.db.patch(target._id, {
      accountState: "active",
      // Cleared, not kept: a stale `lockedAt` on an active account is a lie that
      // the next person reading the row has no way to detect. The audit log is
      // where the history lives.
      lockedAt: undefined,
      lockedByUserId: undefined,
      lockReason: undefined,
      updatedAt: now,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.accountUnlocked,
      subjectType: "user",
      subjectId: target._id,
      actor: { userId: admin._id, role: "globalAdmin" },
      reason: input.reason,
      metadata: { previousState: "locked" },
      now,
    });

    return { accountState: "active" as const };
  },
});

/** Queue an account for erasure, thirty days out. Reversible until it runs. */
export const scheduleAccountDeletionFor = mutation({
  args: { userId: v.id("users"), reason: v.string() },
  returns: v.object({ accountState, scheduledAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminAccountActionInputSchema, args);
    const target = await requireTarget(ctx, args.userId);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "account.scheduleDeletion", {
      kind: "account",
      state: target.accountState,
      isSelf: target._id === admin._id,
    });

    // The shared path, so an admin-scheduled deletion and a self-service one
    // produce the same job, the same grace period and the same audit row.
    const result = await scheduleAccountDeletion(ctx, target, {
      requestedByUserId: admin._id,
      reason: input.reason,
    });

    return { accountState: "deletionScheduled" as const, scheduledAt: result.scheduledAt ?? null };
  },
});

/**
 * Cancel a scheduled deletion and put the account back.
 *
 * Restores to `active`, not to `locked`. An account that was locked and then
 * scheduled comes back unlocked, and re-locking it is one extra explicit action
 * — which is what `ACCOUNT_TRANSITIONS` already says, and is the safer default:
 * a restore that silently re-applies a suspension nobody mentioned is a restore
 * that gets reported as a bug at the worst moment.
 */
export const restoreAccount = mutation({
  args: { userId: v.id("users"), reason: v.string() },
  returns: v.object({ accountState, cancelledJobs: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminAccountActionInputSchema, args);
    const target = await requireTarget(ctx, args.userId);

    requirePermission(toPermissionActor(admin, "globalAdmin"), "account.restoreDeletion", {
      kind: "account",
      state: target.accountState,
      isSelf: target._id === admin._id,
    });

    assertAccountTransition(target.accountState, "active");

    const now = Date.now();
    await ctx.db.patch(target._id, {
      accountState: "active",
      deletionScheduledAt: undefined,
      updatedAt: now,
    });

    const jobs = await ctx.db
      .query("deletionJobs")
      .withIndex("by_subject", (q) => q.eq("subjectType", "user").eq("subjectId", target._id))
      .collect();

    let cancelled = 0;
    for (const job of jobs) {
      if (job.state !== "scheduled") continue;
      await ctx.db.patch(job._id, {
        state: "cancelled",
        cancelledAt: now,
        cancelledByUserId: admin._id,
      });
      cancelled += 1;
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.accountDeletionRestored,
      subjectType: "user",
      subjectId: target._id,
      actor: { userId: admin._id, role: "globalAdmin" },
      reason: input.reason,
      metadata: { cancelledJobs: cancelled },
      now,
    });

    return { accountState: "active" as const, cancelledJobs: cancelled };
  },
});

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export const scheduleEventDeletion = mutation({
  args: { eventId: v.id("events"), reason: v.string() },
  returns: v.object({ state: eventState, scheduledAt: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminEventActionInputSchema, args);

    const event = await ctx.db.get(args.eventId);
    if (!event) throw notFound("That event");

    requirePermission(toPermissionActor(admin, "globalAdmin"), "event.scheduleDeletion", {
      kind: "event",
      state: event.state,
    });

    try {
      eventStateMachine.assertTransition(event.state, "deletionScheduled");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw invalidState(error.message);
      throw error;
    }

    const now = Date.now();
    const scheduledAt = now + ACCOUNT_DELETION_GRACE_MS;

    await ctx.db.patch(event._id, {
      state: "deletionScheduled",
      deletionScheduledAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("deletionJobs", {
      subjectType: "event",
      subjectId: event._id,
      state: "scheduled",
      scheduledAt,
      requestedByUserId: admin._id,
      reason: input.reason,
      createdAt: now,
    });

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventDeletionScheduled,
      event,
      actor: { user: admin, role: "globalAdmin" },
      reason: input.reason,
      metadata: { previousState: event.state, scheduledAt },
      now,
    });

    return { state: "deletionScheduled" as const, scheduledAt };
  },
});

/**
 * Put a scheduled event back.
 *
 * It comes back **archived**, which is what `EVENT_TRANSITIONS` allows and the
 * only sane landing place: an event that was `live` when somebody queued it for
 * deletion should not silently start accepting uploads again the moment the
 * queue is cancelled. The host re-opens it deliberately, which re-checks the
 * six-digit code against every other joinable party — see `ensureCodeIsFree`.
 */
export const restoreEvent = mutation({
  args: { eventId: v.id("events"), reason: v.string() },
  returns: v.object({ state: eventState, cancelledJobs: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminEventActionInputSchema, args);

    const event = await ctx.db.get(args.eventId);
    if (!event) throw notFound("That event");

    requirePermission(toPermissionActor(admin, "globalAdmin"), "event.restoreDeletion", {
      kind: "event",
      state: event.state,
    });

    try {
      eventStateMachine.assertTransition(event.state, "archived");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw invalidState(error.message);
      throw error;
    }

    const now = Date.now();
    await ctx.db.patch(event._id, {
      state: "archived",
      deletionScheduledAt: undefined,
      archivedAt: event.archivedAt ?? now,
      updatedAt: now,
    });

    const jobs = await ctx.db
      .query("deletionJobs")
      .withIndex("by_subject", (q) => q.eq("subjectType", "event").eq("subjectId", event._id))
      .collect();

    let cancelled = 0;
    for (const job of jobs) {
      if (job.state !== "scheduled") continue;
      await ctx.db.patch(job._id, {
        state: "cancelled",
        cancelledAt: now,
        cancelledByUserId: admin._id,
      });
      cancelled += 1;
    }

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.eventDeletionRestored,
      event,
      actor: { user: admin, role: "globalAdmin" },
      reason: input.reason,
      metadata: { restoredTo: "archived", cancelledJobs: cancelled },
      now,
    });

    return { state: "archived" as const, cancelledJobs: cancelled };
  },
});

/**
 * Rotate an event's join code from the console — random, or to a chosen value.
 *
 * The specific-value path is first on PLAN.md's cut list and is the reason this
 * is not simply "call `invites.rotate`": a chosen six digits has to be validated
 * for shape, refused if it is guessable, collision-checked **against every
 * joinable event**, and refused if it is the code being rotated away from — that
 * last one because the collision check has to excuse this event's own outgoing
 * code to run at all, and without a second check `482913 → 482913` would revoke
 * the version, tell the admin the poster was dead, and leave the number on it
 * working.
 *
 * The code itself never reaches the audit row. Audit rows are read in bulk and
 * by more people than the host list.
 */
export const rotateEventCode = mutation({
  args: {
    eventId: v.id("events"),
    mode: v.optional(v.union(v.literal("random"), v.literal("specific"))),
    specificCode: v.optional(v.string()),
    keepExistingMemberships: v.optional(v.boolean()),
    reason: v.string(),
  },
  returns: v.object({
    inviteVersionId: v.id("inviteVersions"),
    version: v.number(),
    code: v.string(),
    revokedMemberships: v.number(),
  }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminRotateCodeInputSchema, args);

    const event = await ctx.db.get(args.eventId);
    if (!event) throw notFound("That event");

    requirePermission(toPermissionActor(admin, "globalAdmin"), "event.rotateInvite", {
      kind: "event",
      state: event.state,
    });

    const now = Date.now();
    const budget = await checkRotationThrottle(ctx, event._id, now);
    if (!budget.allowed) throw rateLimited(ROTATION_THROTTLED_MESSAGE, budget.retryAfterMs);

    let specificCode: string | undefined;
    if (input.mode === "specific") {
      const validated = validateSpecificEventCode(input.specificCode ?? "");
      if (!validated.ok) {
        throw invalidInput(
          validated.reason === "format"
            ? "A join code is six digits."
            : "That code is too easy to guess. Pick another.",
        );
      }
      if (await isCodeTaken(ctx, validated.code, { ignoreEventId: event._id })) {
        throw invalidInput("That code is already in use by another event.");
      }
      const current = await getActiveInviteVersion(ctx, event);
      if (current && normalizeEventCode(current.code) === validated.code) {
        throw invalidInput(
          "That is the code you are rotating away from. Pick a different one, or rotate to a random code.",
        );
      }
      specificCode = validated.code;
    }

    const result = await mintInviteVersion(ctx, {
      event,
      createdByUserId: admin._id,
      keepExistingMemberships: input.keepExistingMemberships,
      ...(specificCode === undefined ? {} : { specificCode }),
      reason: input.reason,
      now,
    });

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.inviteRotated,
      event,
      actor: { user: admin, role: "globalAdmin" },
      reason: input.reason,
      metadata: {
        version: result.version,
        previousVersion: result.previousVersion,
        keptMemberships: input.keepExistingMemberships,
        revokedMemberships: result.revokedMembershipIds.length,
        specific: specificCode !== undefined,
        via: "adminConsole",
      },
      now,
    });

    await recordRotation(ctx, event._id, now);

    // The code, and **not** the token. An administrator rotating somebody
    // else's party needs to be able to tell the host the new six digits; the QR
    // token is the bearer credential that would let the console walk into the
    // party it just rotated, which is the one thing `/admin` is defined as not
    // being able to do. The host reads it from their own `invites.current`.
    return {
      inviteVersionId: result.inviteVersionId,
      version: result.version,
      code: result.code,
      revokedMemberships: result.revokedMembershipIds.length,
    };
  },
});

/**
 * Revoke one membership.
 *
 * The narrow instrument, next to the blunt one: locking an account freezes
 * everything they own, and this removes one person from one party. `membership.
 * revoke` refuses `isSelf` and refuses an `owner` target — an owner's seat only
 * goes away by transfer or by the event going — so this cannot be used to
 * decapitate a party from the console. Unspent grants go with the seat, for the
 * same reason they do on rotation.
 */
export const revokeMembership = mutation({
  args: { membershipId: v.id("memberships"), reason: v.string() },
  returns: v.object({ revoked: v.boolean(), expiredGrants: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireGlobalAdmin(ctx);
    const input = parseInput(adminRevokeMembershipInputSchema, args);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership) throw notFound("That membership");

    const event = await ctx.db.get(membership.eventId);
    if (!event) throw notFound("That event");

    requirePermission(toPermissionActor(admin, "globalAdmin"), "membership.revoke", {
      kind: "membership",
      targetRole: membership.role,
      isSelf: membership.userId === admin._id,
      event: { state: event.state },
    });

    /*
     * A membership that is already `revoked` is still acted on, and that is not
     * belt-and-braces.
     *
     * A rotation sweep leaves rows in `status: "revoked", revokedByRotation:
     * true`, and `join.evaluateCredential` deliberately readmits those on a
     * fresh scan — a sweep is a reprinted sign, not a ban. So no-op-ing here
     * meant a guest sitting in the swept state could not be banned **at all**:
     * every call returned `revoked: false` and the next scan let them back in.
     * Re-revoking overwrites the sweep marker with `false`, which is what turns
     * it into a decision.
     */
    if (membership.status === "revoked" && membership.revokedByRotation !== true) {
      return { revoked: false, expiredGrants: 0 };
    }

    const now = Date.now();
    await ctx.db.patch(membership._id, {
      status: "revoked",
      revokedAt: now,
      revokedByUserId: admin._id,
      revokeReason: input.reason,
      // `false`, not `undefined`: the flag means "swept and not since
      // re-decided", and this *is* the re-decision. Clearing it would leave the
      // row indistinguishable from one nobody ever swept, which is right; saying
      // `false` says the same thing and survives a later reader asking whether
      // the question was ever put.
      revokedByRotation: false,
    });

    const expiredGrants = await expireGrantsForUser(ctx, event._id, membership.userId, now);

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipRevoked,
      subjectType: "membership",
      subjectId: membership._id,
      actor: { userId: admin._id, role: "globalAdmin" },
      eventId: event._id,
      reason: input.reason,
      metadata: {
        via: "adminConsole",
        revokedUserId: membership.userId,
        role: membership.role,
        expiredGrants,
      },
      now,
    });

    return { revoked: true, expiredGrants };
  },
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function requireTarget(
  ctx: Parameters<typeof requireGlobalAdmin>[0],
  userId: Id<"users">,
): Promise<Doc<"users">> {
  const target = await ctx.db.get(userId);
  if (!target) throw notFound("That account");
  return target;
}

/**
 * The account state machine, applied.
 *
 * `requirePermission` has already refused the cases the *policy* forbids (an
 * admin locking themselves, unlocking something that is not locked). This
 * catches the cases the *machine* forbids — chiefly anything out of `deleted`,
 * which is terminal — and turns an illegal move into an `invalidState` a console
 * can render rather than an unhandled throw.
 */
function assertAccountTransition(
  from: Doc<"users">["accountState"],
  to: "active" | "locked",
): void {
  if (from === to) return;
  try {
    accountStateMachine.assertTransition(from, to);
  } catch (error) {
    if (error instanceof InvalidTransitionError) throw invalidState(error.message);
    throw error;
  }
}

/**
 * The allowlist, re-asked inside the internal mutation.
 *
 * `requireGlobalAdmin` is the normal gate and it reads the environment; this is
 * the same question in the one place that cannot call it, because it has a user
 * row rather than an auth context. Importing `isAdminEmail` directly keeps the
 * authority in one file.
 */
function isAllowlisted(user: Doc<"users">): boolean {
  return isAdminEmail(user.email);
}
