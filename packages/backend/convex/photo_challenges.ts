import {
  normalizePhotoChallengePrompt,
  PHOTO_CHALLENGE_MAX_ACTIVE,
  PHOTO_CHALLENGE_MIN_ACTIVE,
  photoChallengePromptSchema,
  pickPhotoChallengeIndex,
} from "@partybooth/contracts/photo-challenges";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { forbidden, invalidInput, invalidState, notFound } from "./lib/errors";
import { requireEventActor, requireEventRole } from "./lib/guards";
import { parseInput } from "./lib/input";

const assignmentValidator = v.object({
  id: v.id("photoChallengeAssignments"),
  challengeId: v.id("photoChallenges"),
  prompt: v.string(),
  cycle: v.number(),
  assignedAt: v.number(),
});

const guestChallengeValidator = v.union(
  v.object({
    outcome: v.literal("available"),
    assignment: assignmentValidator,
  }),
  v.object({
    outcome: v.literal("disabled"),
    reason: v.union(v.literal("hostDisabled"), v.literal("notEnoughPrompts")),
  }),
);

type GuestChallengeResult =
  | { outcome: "available"; assignment: AssignmentView }
  | { outcome: "disabled"; reason: "hostDisabled" | "notEnoughPrompts" };

interface AssignmentView {
  id: Id<"photoChallengeAssignments">;
  challengeId: Id<"photoChallenges">;
  prompt: string;
  cycle: number;
  assignedAt: number;
}

const challengeValidator = v.object({
  id: v.id("photoChallenges"),
  prompt: v.string(),
  status: v.union(v.literal("active"), v.literal("archived")),
  source: v.union(v.literal("starter"), v.literal("custom")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const list = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    enabled: v.boolean(),
    activeCount: v.number(),
    minimumActive: v.number(),
    maximumActive: v.number(),
    challenges: v.array(challengeValidator),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventRole(ctx, args.eventId, "cohost");
    const rows = await ctx.db
      .query("photoChallenges")
      .withIndex("by_event_and_status", (q) =>
        q.eq("eventId", actor.event._id).eq("status", "active"),
      )
      .take(PHOTO_CHALLENGE_MAX_ACTIVE + 1);
    const challenges = rows.map(projectChallenge).sort((a, b) => a.createdAt - b.createdAt);
    return {
      enabled: actor.event.photoChallengesEnabled ?? false,
      activeCount: rows.length,
      minimumActive: PHOTO_CHALLENGE_MIN_ACTIVE,
      maximumActive: PHOTO_CHALLENGE_MAX_ACTIVE,
      challenges,
    };
  },
});

/** Archived prompts are unbounded, so hosts page through them separately. */
export const listArchived = query({
  args: {
    eventId: v.id("events"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(challengeValidator),
  handler: async (ctx, args) => {
    const actor = await requireEventRole(ctx, args.eventId, "cohost");
    const page = await ctx.db
      .query("photoChallenges")
      .withIndex("by_event_and_status", (q) =>
        q.eq("eventId", actor.event._id).eq("status", "archived"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(projectChallenge) };
  },
});

export const create = mutation({
  args: { eventId: v.id("events"), prompt: v.string() },
  returns: challengeValidator,
  handler: async (ctx, args) => {
    const actor = await requireEventRole(ctx, args.eventId, "cohost");
    const prompt = parseInput(photoChallengePromptSchema, args.prompt);
    const normalizedPrompt = normalizePhotoChallengePrompt(prompt);
    await assertNoDuplicate(ctx, actor.event._id, normalizedPrompt);
    const active = await activeChallenges(ctx, actor.event._id);
    if (active.length >= PHOTO_CHALLENGE_MAX_ACTIVE) {
      throw invalidState(
        `An event can have at most ${PHOTO_CHALLENGE_MAX_ACTIVE} active challenges.`,
      );
    }
    const now = Date.now();
    const id = await ctx.db.insert("photoChallenges", {
      eventId: actor.event._id,
      prompt,
      normalizedPrompt,
      status: "active",
      source: "custom",
      createdByUserId: actor.user._id,
      updatedByUserId: actor.user._id,
      createdAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw notFound("That challenge");
    return projectChallenge(row);
  },
});

export const update = mutation({
  args: { challengeId: v.id("photoChallenges"), prompt: v.string() },
  returns: challengeValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.challengeId);
    if (!row) throw notFound("That challenge");
    const actor = await requireEventRole(ctx, row.eventId, "cohost");
    const prompt = parseInput(photoChallengePromptSchema, args.prompt);
    const normalizedPrompt = normalizePhotoChallengePrompt(prompt);
    await assertNoDuplicate(ctx, row.eventId, normalizedPrompt, row._id);
    await ctx.db.patch(row._id, {
      prompt,
      normalizedPrompt,
      updatedByUserId: actor.user._id,
      updatedAt: Date.now(),
    });
    return projectChallenge({ ...row, prompt, normalizedPrompt, updatedAt: Date.now() });
  },
});

export const setArchived = mutation({
  args: { challengeId: v.id("photoChallenges"), archived: v.boolean() },
  returns: challengeValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.challengeId);
    if (!row) throw notFound("That challenge");
    const actor = await requireEventRole(ctx, row.eventId, "cohost");
    const status = args.archived ? "archived" : "active";
    if (row.status === status) return projectChallenge(row);
    if (status === "active") {
      const active = await activeChallenges(ctx, row.eventId);
      if (active.length >= PHOTO_CHALLENGE_MAX_ACTIVE) {
        throw invalidState(
          `An event can have at most ${PHOTO_CHALLENGE_MAX_ACTIVE} active challenges.`,
        );
      }
      await assertNoDuplicate(ctx, row.eventId, row.normalizedPrompt, row._id);
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status,
      updatedByUserId: actor.user._id,
      updatedAt: now,
      archivedAt: args.archived ? now : undefined,
    });
    return projectChallenge({ ...row, status, updatedAt: now });
  },
});

export const setEnabled = mutation({
  args: { eventId: v.id("events"), enabled: v.boolean() },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireEventRole(ctx, args.eventId, "cohost");
    if (args.enabled) {
      const active = await activeChallenges(ctx, actor.event._id);
      if (active.length < PHOTO_CHALLENGE_MIN_ACTIVE) {
        throw invalidState(
          `Add at least ${PHOTO_CHALLENGE_MIN_ACTIVE} active challenges before turning this on.`,
        );
      }
    }
    await ctx.db.patch(actor.event._id, {
      photoChallengesEnabled: args.enabled,
      updatedAt: Date.now(),
    });
    return { enabled: args.enabled };
  },
});

/** Draws the account's current challenge once; repeated calls return the same assignment. */
export const currentOrDraw = mutation({
  args: { eventId: v.id("events") },
  returns: guestChallengeValidator,
  handler: async (ctx, args): Promise<GuestChallengeResult> => {
    const actor = await requireGuestActor(ctx, args.eventId);
    return await drawFor(ctx, actor.event, actor.user._id, Date.now());
  },
});

/** "Another challenge" resolves the current snapshot and draws from the remaining cycle. */
export const skip = mutation({
  args: { assignmentId: v.id("photoChallengeAssignments") },
  returns: guestChallengeValidator,
  handler: async (ctx, args): Promise<GuestChallengeResult> => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw notFound("That challenge");
    const actor = await requireGuestActor(ctx, assignment.eventId);
    await resolveCurrent(ctx, assignment, actor.user._id, "skipped", Date.now());
    return await drawFor(ctx, actor.event, actor.user._id, Date.now());
  },
});

/** Resolve only after the guest confirms the captured frame, then advance. */
export const resolve = mutation({
  args: {
    assignmentId: v.id("photoChallengeAssignments"),
    outcome: v.union(v.literal("used"), v.literal("dismissed")),
    captureId: v.string(),
  },
  returns: guestChallengeValidator,
  handler: async (ctx, args): Promise<GuestChallengeResult> => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw notFound("That challenge");
    const actor = await requireGuestActor(ctx, assignment.eventId);
    const captureId = args.captureId.trim();
    if (captureId.length === 0 || captureId.length > 128)
      throw invalidInput("That capture id is not valid.");
    const now = Date.now();
    if (assignment.status !== "current") {
      const recordedCaptureId = assignment.resolutionCaptureId ?? assignment.usedCaptureId;
      if (
        assignment.userId !== actor.user._id ||
        assignment.status !== args.outcome ||
        recordedCaptureId !== captureId
      ) {
        throw invalidState("That challenge is no longer current.");
      }
      return await drawFor(ctx, actor.event, actor.user._id, now);
    }
    await resolveCurrent(ctx, assignment, actor.user._id, args.outcome, now, captureId);
    return await drawFor(ctx, actor.event, actor.user._id, now);
  },
});

async function requireGuestActor(
  ctx: Parameters<typeof requireEventActor>[0],
  eventId: Id<"events">,
) {
  const actor = await requireEventActor(ctx, eventId);
  if (actor.user.accountState !== "active")
    throw forbidden("This account cannot use challenges right now.");
  if (actor.role === "globalAdmin") throw forbidden();
  return actor;
}

async function drawFor(
  ctx: MutationCtx,
  event: Doc<"events">,
  userId: Id<"users">,
  now: number,
): Promise<GuestChallengeResult> {
  if (!(event.photoChallengesEnabled ?? false)) {
    return { outcome: "disabled", reason: "hostDisabled" };
  }
  const active = await activeChallenges(ctx, event._id);
  if (active.length < PHOTO_CHALLENGE_MIN_ACTIVE) {
    return { outcome: "disabled", reason: "notEnoughPrompts" };
  }
  const progress = await ctx.db
    .query("photoChallengeProgress")
    .withIndex("by_event_and_user", (q) => q.eq("eventId", event._id).eq("userId", userId))
    .unique();
  if (progress?.currentAssignmentId) {
    const current = await ctx.db.get(progress.currentAssignmentId);
    if (current?.status === "current") return available(current);
  }

  let cycle = progress?.cycle ?? 1;
  let seen = progress?.seenChallengeIds ?? [];
  let candidates = active.filter((challenge) => !seen.includes(challenge._id));
  if (candidates.length === 0) {
    cycle += 1;
    seen = [];
    candidates = active;
  }
  const challenge = candidates[pickPhotoChallengeIndex(candidates.length)];
  if (!challenge) return { outcome: "disabled", reason: "notEnoughPrompts" };
  const assignmentId = await ctx.db.insert("photoChallengeAssignments", {
    eventId: event._id,
    userId,
    challengeId: challenge._id,
    promptSnapshot: challenge.prompt,
    cycle,
    status: "current",
    assignedAt: now,
  });
  const nextSeen = [...seen, challenge._id];
  if (progress) {
    await ctx.db.patch(progress._id, {
      cycle,
      seenChallengeIds: nextSeen,
      currentAssignmentId: assignmentId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("photoChallengeProgress", {
      eventId: event._id,
      userId,
      cycle,
      seenChallengeIds: nextSeen,
      currentAssignmentId: assignmentId,
      updatedAt: now,
    });
  }
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw notFound("That challenge");
  return available(assignment);
}

async function resolveCurrent(
  ctx: MutationCtx,
  assignment: Doc<"photoChallengeAssignments">,
  userId: Id<"users">,
  status: "skipped" | "dismissed" | "used",
  now: number,
  captureId?: string,
): Promise<void> {
  if (assignment.userId !== userId || assignment.status !== "current") {
    throw invalidState("That challenge is no longer current.");
  }
  const progress = await ctx.db
    .query("photoChallengeProgress")
    .withIndex("by_event_and_user", (q) => q.eq("eventId", assignment.eventId).eq("userId", userId))
    .unique();
  if (!progress || progress.currentAssignmentId !== assignment._id) {
    throw invalidState("That challenge is no longer current.");
  }
  await ctx.db.patch(assignment._id, {
    status,
    resolvedAt: now,
    ...(captureId === undefined ? {} : { resolutionCaptureId: captureId }),
    ...(status === "used" && captureId !== undefined ? { usedCaptureId: captureId } : {}),
  });
  await ctx.db.patch(progress._id, { currentAssignmentId: undefined, updatedAt: now });
}

async function activeChallenges(
  ctx: Parameters<typeof requireEventActor>[0],
  eventId: Id<"events">,
) {
  return await ctx.db
    .query("photoChallenges")
    .withIndex("by_event_and_status", (q) => q.eq("eventId", eventId).eq("status", "active"))
    .take(PHOTO_CHALLENGE_MAX_ACTIVE + 1);
}

async function assertNoDuplicate(
  ctx: MutationCtx,
  eventId: Id<"events">,
  normalizedPrompt: string,
  except?: Id<"photoChallenges">,
): Promise<void> {
  const rows = await ctx.db
    .query("photoChallenges")
    .withIndex("by_event_and_normalized", (q) =>
      q.eq("eventId", eventId).eq("normalizedPrompt", normalizedPrompt),
    )
    .take(2);
  if (rows.some((row) => row._id !== except))
    throw invalidInput("That challenge is already in this event.");
}

function available(row: Doc<"photoChallengeAssignments">): GuestChallengeResult {
  return {
    outcome: "available",
    assignment: {
      id: row._id,
      challengeId: row.challengeId,
      prompt: row.promptSnapshot,
      cycle: row.cycle,
      assignedAt: row.assignedAt,
    },
  };
}

function projectChallenge(row: Doc<"photoChallenges">) {
  return {
    id: row._id,
    prompt: row.prompt,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
