import {
  accountJoinKey,
  AUDIT_ACTIONS,
  joinEventInputSchema,
  joinRejected,
  joinThrottled,
  networkJoinKey,
  type JoinRejectionReason,
  type JoinResult,
} from "@partybooth/contracts";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { applyVerifiedEmailMatching } from "./lib/email-matching";
import {
  adoptActiveEvent,
  checkInviteJoinable,
  resolveInviteByCode,
  resolveInviteByToken,
  type ResolvedInvite,
} from "./lib/events";
import { getActiveMembership, requireActiveUser, type ReadCtx } from "./lib/guards";
import { sha256Hex } from "./lib/hash";
import { parseInput } from "./lib/input";
import { checkJoinThrottle, recordJoinFailure, recordJoinSuccess } from "./lib/join-throttle";
import { eventState } from "./lib/validators";

/**
 * The join flow.
 *
 * PLAN.md: "authenticated, rate-limited, enumeration-protected and audited".
 * All four, in that order, and the third is the one with teeth:
 *
 * > a six-digit code is only a million values, so failed-join responses must
 * > not distinguish "no such event" from "wrong version" from "not live".
 *
 * So every failure returns the *same value* — `joinRejected()`, one string,
 * built in `@partybooth/contracts` so it cannot drift. The real reason is
 * written to `auditEvents`, where it belongs: "they scanned last month's
 * poster" and "somebody is walking the keyspace" need to be told apart by us
 * and by nobody else.
 *
 * Failures are values rather than exceptions on purpose. A thrown error is a
 * different code path with different timing and a different shape on the wire,
 * and three of those is an oracle.
 */

const inviteArg = v.union(
  v.object({ via: v.literal("token"), token: v.string() }),
  v.object({ via: v.literal("code"), code: v.string() }),
);

const joinResultValidator = v.union(
  v.object({
    outcome: v.literal("joined"),
    eventId: v.id("events"),
    membershipId: v.id("memberships"),
    role: v.union(v.literal("owner"), v.literal("cohost"), v.literal("guest")),
    alreadyMember: v.boolean(),
  }),
  v.object({ outcome: v.literal("rejected"), message: v.string() }),
  v.object({
    outcome: v.literal("throttled"),
    message: v.string(),
    retryAfterMs: v.number(),
  }),
);

/* -------------------------------------------------------------------------- */
/* Throttle keys                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which keys this attempt is charged to.
 *
 * The account key always exists — joining is authenticated. The network key is
 * optional because a Convex mutation has no client address: the web join route
 * can pass one through, and it is hashed here so the throttle table never holds
 * a raw address. A client that omits or forges it can only ever *add* a key to
 * be throttled on, never remove the account one.
 */
async function throttleKeys(
  userId: Id<"users">,
  networkKey: string | undefined,
): Promise<string[]> {
  const keys = [accountJoinKey(userId)];
  if (networkKey !== undefined && networkKey.trim() !== "") {
    keys.push(networkJoinKey(await sha256Hex(networkKey.trim())));
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* Rejection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Record a failure and return the one rejection value.
 *
 * Every caller returns exactly what this returns; nothing branches on the
 * reason after this point.
 */
async function reject(
  ctx: MutationCtx,
  params: {
    keys: readonly string[];
    userId: Id<"users">;
    reason: JoinRejectionReason;
    via: "code" | "token";
    eventId?: Id<"events"> | undefined;
    now: number;
  },
): Promise<JoinResult<Id<"events">, Id<"memberships">>> {
  await recordJoinFailure(ctx, params.keys, params.now);
  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.joinRejected,
    subjectType: "membership",
    actor: { userId: params.userId },
    eventId: params.eventId,
    metadata: { reason: params.reason, via: params.via },
    now: params.now,
  });
  return joinRejected();
}

/* -------------------------------------------------------------------------- */
/* join                                                                       */
/* -------------------------------------------------------------------------- */

export const join = mutation({
  args: {
    invite: inviteArg,
    /**
     * An opaque per-client value (the web route passes a hashed address). It is
     * hashed again here and only ever adds a throttle key.
     */
    networkKey: v.optional(v.string()),
  },
  returns: joinResultValidator,
  handler: async (ctx, args): Promise<JoinResult<Id<"events">, Id<"memberships">>> => {
    // A locked or deletion-scheduled account is refused before anything else.
    // That is not an enumeration leak: it is a fact about the caller's own
    // account, which they already know.
    const user = await requireActiveUser(ctx);

    const input = parseInput(joinEventInputSchema, args.invite);
    const now = Date.now();
    const keys = await throttleKeys(user._id, args.networkKey);

    const throttle = await checkJoinThrottle(ctx, keys, now);
    if (!throttle.allowed) {
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.joinRejected,
        subjectType: "membership",
        actor: { userId: user._id },
        metadata: { reason: "throttled", via: input.via },
        now,
      });
      return joinThrottled(throttle.retryAfterMs);
    }

    const invite: ResolvedInvite | null =
      input.via === "token"
        ? await resolveInviteByToken(ctx, input.token)
        : await resolveInviteByCode(ctx, input.code);

    if (!invite) {
      return await reject(ctx, {
        keys,
        userId: user._id,
        reason: "unknownCredential",
        via: input.via,
        now,
      });
    }

    const verdict = checkInviteJoinable(invite, now);
    if (!verdict.joinable) {
      return await reject(ctx, {
        keys,
        userId: user._id,
        reason: verdict.reason,
        via: input.via,
        eventId: invite.event._id,
        now,
      });
    }

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_user", (q) =>
        q.eq("eventId", invite.event._id).eq("userId", user._id),
      )
      .unique();

    // A host removed this person. A fresh scan of the same QR must not undo
    // that — only a co-host invite or a rotation that keeps memberships does.
    if (existing?.status === "revoked") {
      return await reject(ctx, {
        keys,
        userId: user._id,
        reason: "membershipRevoked",
        via: input.via,
        eventId: invite.event._id,
        now,
      });
    }

    await recordJoinSuccess(ctx, keys, now);

    const result = await admit(ctx, {
      user,
      invite,
      existing,
      via: input.via,
      now,
    });

    await adoptActiveEvent(ctx, user, invite.event._id, now);
    return result;
  },
});

/**
 * Create or refresh the membership, then let verified-email matching have the
 * last word on the role.
 *
 * Everyone comes in as a `guest`. Matching is what turns a verified address
 * into a co-host seat, so a host who was invited by email before they had an
 * account still lands with host powers on the first scan — and a guest cannot
 * assert one, because the only input is an address a provider or an OTP
 * vouched for.
 */
async function admit(
  ctx: MutationCtx,
  params: {
    user: Doc<"users">;
    invite: ResolvedInvite;
    existing: Doc<"memberships"> | null;
    via: "code" | "token";
    now: number;
  },
): Promise<JoinResult<Id<"events">, Id<"memberships">>> {
  const { user, invite, existing, now } = params;

  const alreadyMember = existing?.status === "active";
  let membershipId: Id<"memberships">;

  if (existing) {
    membershipId = existing._id;
    if (!alreadyMember) {
      // "left" — they walked out and came back. Same row, fresh version.
      await ctx.db.patch(existing._id, {
        status: "active",
        inviteVersionId: invite.version._id,
        joinedAt: now,
      });
    } else if (existing.inviteVersionId !== invite.version._id) {
      // Re-scanning after a rotation that kept memberships: move them onto the
      // current version so the next rotation can revoke them cleanly.
      await ctx.db.patch(existing._id, { inviteVersionId: invite.version._id });
    }
  } else {
    membershipId = await ctx.db.insert("memberships", {
      eventId: invite.event._id,
      userId: user._id,
      role: invite.event.ownerUserId === user._id ? "owner" : "guest",
      status: "active",
      inviteVersionId: invite.version._id,
      joinedAt: now,
    });
  }

  if (!alreadyMember) {
    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipCreated,
      subjectType: "membership",
      subjectId: membershipId,
      actor: { userId: user._id },
      eventId: invite.event._id,
      metadata: { via: params.via, inviteVersion: invite.version.version },
      now,
    });
  }

  // May upgrade the row just written to `cohost`, or unlock organiser powers.
  await applyVerifiedEmailMatching(ctx, user, { now });

  const settled = await ctx.db.get(membershipId);
  return {
    outcome: "joined",
    eventId: invite.event._id,
    membershipId,
    role: settled?.role ?? "guest",
    alreadyMember,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

const previewValidator = v.union(
  v.null(),
  v.object({
    eventId: v.id("events"),
    name: v.string(),
    state: eventState,
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    timeZone: v.string(),
    accentColor: v.optional(v.string()),
    coverKey: v.optional(v.string()),
    hostDisplayName: v.string(),
    /** `true` when this account is already in — the UI says "open" not "join". */
    alreadyMember: v.boolean(),
  }),
);

async function preview(
  ctx: ReadCtx,
  invite: ResolvedInvite | null,
  userId: Id<"users"> | null,
  now: number,
): Promise<{
  eventId: Id<"events">;
  name: string;
  state: Doc<"events">["state"];
  startsAt: number;
  endsAt?: number;
  timeZone: string;
  accentColor?: string;
  coverKey?: string;
  hostDisplayName: string;
  alreadyMember: boolean;
} | null> {
  if (!invite) return null;
  if (!checkInviteJoinable(invite, now).joinable) return null;

  const owner = await ctx.db.get(invite.event.ownerUserId);
  const membership = userId ? await getActiveMembership(ctx, invite.event._id, userId) : null;

  // Deliberately thin: the name, when, and whose party it is. No counts, no
  // guest list, no media — a preview is a "yes, this is the right party"
  // check, not a window into it.
  return {
    eventId: invite.event._id,
    name: invite.event.name,
    state: invite.event.state,
    startsAt: invite.event.startsAt,
    ...(invite.event.endsAt === undefined ? {} : { endsAt: invite.event.endsAt }),
    timeZone: invite.event.timeZone,
    ...(invite.event.accentColor === undefined ? {} : { accentColor: invite.event.accentColor }),
    ...(invite.event.coverKey === undefined ? {} : { coverKey: invite.event.coverKey }),
    hostDisplayName: owner?.displayName ?? "The host",
    alreadyMember: membership !== null,
  };
}

/**
 * Preview from a QR / universal link.
 *
 * A **query**, and unauthenticated, because the token is 160 bits: there is
 * nothing to enumerate, and the join page has to render something before the
 * guest has signed in. `null` covers "no such token", "superseded" and "not
 * joinable" alike.
 */
export const previewByToken = query({
  args: { token: v.string() },
  returns: previewValidator,
  handler: async (ctx, args) => {
    const identityUser = await ctx.auth.getUserIdentity();
    const user = identityUser
      ? await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", identityUser.subject))
          .unique()
      : null;
    const invite = await resolveInviteByToken(ctx, args.token);
    return await preview(ctx, invite, user?._id ?? null, Date.now());
  },
});

/**
 * Preview from a typed six-digit code.
 *
 * A **mutation**, which looks wrong and is not. Six digits is a million values;
 * an unthrottled query that answers "is this a real code?" is exactly the
 * oracle the whole join flow is built to deny. Only a mutation can spend a
 * throttle budget, so this one is authenticated, charged against the same keys
 * as a join, and returns the same `null` for every failure.
 */
export const previewByCode = mutation({
  args: { code: v.string(), networkKey: v.optional(v.string()) },
  returns: previewValidator,
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(joinEventInputSchema, { via: "code", code: args.code });
    if (input.via !== "code") return null;

    const now = Date.now();
    const keys = await throttleKeys(user._id, args.networkKey);

    if (!(await checkJoinThrottle(ctx, keys, now)).allowed) return null;

    const invite = await resolveInviteByCode(ctx, input.code);
    const result = await preview(ctx, invite, user._id, now);

    if (result === null) {
      await recordJoinFailure(ctx, keys, now);
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.joinRejected,
        subjectType: "membership",
        actor: { userId: user._id },
        metadata: { reason: "unknownCredential", via: "code", preview: true },
        now,
      });
    }

    return result;
  },
});
