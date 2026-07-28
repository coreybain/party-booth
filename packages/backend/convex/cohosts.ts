import {
  AUDIT_ACTIONS,
  generateSecret,
  inviteCohostInputSchema,
  removeCohostInputSchema,
  revokeCohostInviteInputSchema,
} from "@partybooth/contracts";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent, writeEventAudit } from "./lib/audit";
import { siteUrl } from "./lib/config";
import { COHOST_INVITATION_TTL_MS } from "./lib/email-matching";
import { cohostInviteEmail, sendEmail } from "./lib/email";
import { forbidden, invalidInput, notConfigured, notFound, unauthenticated } from "./lib/errors";
import {
  assertDemoConfinement,
  requireEventActor,
  requirePermission,
  resolveEventRole,
  toPermissionActor,
} from "./lib/guards";
import { assertEventNotFrozen } from "./lib/lock";
import { parseInput } from "./lib/input";
import { expireGrantsForUser } from "./lib/upload-grants";
import { cohostInvitationStatus, eventRole, membershipStatus } from "./lib/validators";

/**
 * Co-hosts: inviting one by address, withdrawing the invitation, and removing
 * one who is already in.
 *
 * ## Why the invitation is an address rather than a person
 *
 * The whole point is that the person may not have an account. `memberships`
 * cannot express that — its `userId` is required — so `cohostInvitations` holds
 * the promise until somebody with a **verified** matching address appears, at
 * which point `lib/email-matching.ts` turns it into a `cohost` membership. That
 * seam has existed since Sprint 2 and is untouched here; this file is the half
 * that creates rows for it to match, and the emails that tell somebody to go and
 * look.
 *
 * ## The token in the email is not a credential
 *
 * `cohostInvitations.token` addresses the invitation in a link. It does **not**
 * grant anything: acceptance binds on a verified address matching `email`, so a
 * forwarded email hands on a URL that shows somebody else's invitation and gets
 * them nothing. That is deliberate and it is the difference between this and the
 * organiser invitation, which is claimed by token: a co-host seat carries the
 * ability to see every guest's photographs, including the pending ones, and a
 * capability like that must not be transferable by forwarding a message.
 *
 * ## Who may do what
 *
 * `membership.inviteCohost` and `membership.revokeCohostInvite` are **owner
 * only** — a co-host may run the party and may not grow the host list — and
 * `membership.revoke` refuses a co-host acting on another co-host
 * (`membershipGate` in `@partybooth/contracts/permissions`). Every refusal here
 * goes through `requirePermission` rather than a role comparison, so the matrix
 * is enforced by the same pure function the tests enumerate.
 */

/** Same cast as `emails.ts`: the generic `AnyApi` fallback until codegen runs. */
type CreateInviteResult =
  | {
      ok: true;
      invitationId: Id<"cohostInvitations">;
      token: string;
      eventName: string;
      invitedByName: string;
      alreadyMember: boolean;
    }
  | { ok: false; reason: "alreadyHost" };

const cohostFunctions = internal.cohosts as unknown as {
  createInvitation: FunctionReference<
    "mutation",
    "internal",
    { authId: string; eventId: Id<"events">; email: string },
    CreateInviteResult
  >;
};

/* -------------------------------------------------------------------------- */
/* Invite                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write the invitation. Called only by the action below, which then emails it.
 *
 * Split from the send for the same reason `emails.issueChallenge` is: a Convex
 * mutation has no `fetch`, and the transaction has to commit before anything
 * leaves the building. If the email then fails, the invitation still stands —
 * which is the right way round, because verified-email matching will honour it
 * the moment its owner signs in, whether or not they were ever told.
 */
export const createInvitation = internalMutation({
  args: { authId: v.string(), eventId: v.id("events"), email: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      invitationId: v.id("cohostInvitations"),
      token: v.string(),
      eventName: v.string(),
      invitedByName: v.string(),
      alreadyMember: v.boolean(),
    }),
    v.object({ ok: v.literal(false), reason: v.literal("alreadyHost") }),
  ),
  handler: async (ctx, args): Promise<CreateInviteResult> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user) throw unauthenticated();

    const event = await ctx.db.get(args.eventId);
    if (!event) throw notFound("That event");

    /*
     * The actor is resolved from `authId` rather than from `ctx.auth`.
     *
     * This is an internal mutation reached through `ctx.runMutation` from an
     * action, and depending on the auth context surviving that hop would make
     * the security of the whole path a property of a Convex implementation
     * detail. The action reads the identity, this re-reads the row, and the same
     * three checks every other event-scoped write makes are made explicitly:
     * demo confinement, the owner-lock freeze, and the role.
     */
    assertDemoConfinement(user, event);
    await assertEventNotFrozen(ctx, event, { knownOwner: user });

    const resolved = await resolveEventRole(ctx, event, user);
    if (!resolved) throw notFound("That event");
    const actor = { user, event, role: resolved.role };

    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot invite anybody right now.");
    }

    const input = parseInput(inviteCohostInputSchema, {
      eventId: args.eventId,
      email: args.email,
    });

    // Owner only. A co-host runs the party; it does not grow the host list.
    requirePermission(toPermissionActor(actor.user, actor.role), "membership.inviteCohost", {
      kind: "membership",
      targetRole: "cohost",
      isSelf: false,
      event: { state: actor.event.state },
    });

    if (input.email === actor.user.email.trim().toLowerCase()) {
      throw invalidInput("You are already the host of this party.");
    }

    const now = Date.now();

    /*
     * An address that already belongs to an active host of this event.
     *
     * Checked before the row is written rather than left to matching, because
     * the failure is a person being emailed "you are now a co-host" for a party
     * they already co-host, and because an owner invited by address would
     * otherwise get an invitation that matching correctly refuses to apply —
     * a promise nothing can keep.
     */
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", input.email))
      .first();

    let alreadyMember = false;
    if (existingUser) {
      if (event.ownerUserId === existingUser._id) return { ok: false, reason: "alreadyHost" };
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_event_and_user", (q) =>
          q.eq("eventId", event._id).eq("userId", existingUser._id),
        )
        .unique();
      if (membership?.status === "active" && membership.role === "cohost") {
        return { ok: false, reason: "alreadyHost" };
      }
      alreadyMember = membership?.status === "active";
    }

    const open = (
      await ctx.db
        .query("cohostInvitations")
        .withIndex("by_event_and_email", (q) => q.eq("eventId", event._id).eq("email", input.email))
        .collect()
    ).find((row) => row.status === "pending");

    // Re-inviting refreshes the expiry and reuses the token, so the link in the
    // first email keeps working. A second token would quietly kill a message the
    // recipient may be reading right now.
    const token = open?.token ?? generateSecret(24);
    let invitationId: Id<"cohostInvitations">;

    if (open) {
      invitationId = open._id;
      await ctx.db.patch(open._id, { expiresAt: now + COHOST_INVITATION_TTL_MS, token });
    } else {
      invitationId = await ctx.db.insert("cohostInvitations", {
        eventId: event._id,
        email: input.email,
        status: "pending",
        invitedByUserId: actor.user._id,
        token,
        expiresAt: now + COHOST_INVITATION_TTL_MS,
        createdAt: now,
      });
    }

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.cohostInvited,
      event,
      actor: { user: actor.user, role: actor.role },
      // No address in the metadata: audit rows are read in bulk and this one
      // would turn the log into a mailing list. The invitation row has it.
      metadata: { invitationId, renewed: open !== undefined, alreadyMember },
      now,
    });

    return {
      ok: true,
      invitationId,
      token,
      eventName: event.name,
      invitedByName: actor.user.displayName,
      alreadyMember,
    };
  },
});

/**
 * Invite somebody to co-host, by email.
 *
 * An **action**, because sending needs `fetch`. The invitation is committed
 * first and the email is best-effort after it: a Resend outage must not lose the
 * seat, and matching honours the row whether or not the message arrived.
 */
export const invite = action({
  args: { eventId: v.id("events"), email: v.string() },
  returns: v.object({
    invitationId: v.id("cohostInvitations"),
    emailed: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ invitationId: Id<"cohostInvitations">; emailed: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw unauthenticated();

    const created = await ctx.runMutation(cohostFunctions.createInvitation, {
      authId: identity.subject,
      eventId: args.eventId,
      email: args.email,
    });

    if (!created.ok) {
      throw invalidInput("That person is already a host of this party.");
    }

    const message = cohostInviteEmail({
      eventName: created.eventName,
      invitedByName: created.invitedByName,
      joinUrl: `${stripTrailingSlash(siteUrl())}/invite/${created.token}`,
    });
    const result = await sendEmail({ ...message, to: args.email });

    if (!result.ok) {
      // Deliberately not fatal — the row is committed and matching will honour
      // it — but the host has to know the message did not go, or they will stand
      // there waiting for somebody who was never told.
      throw notConfigured("Email delivery");
    }

    return { invitationId: created.invitationId, emailed: true };
  },
});

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/* -------------------------------------------------------------------------- */
/* Revoke an invitation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Withdraw an invitation nobody has accepted yet.
 *
 * The row is moved to `revoked` rather than deleted, so "who was invited to this
 * party and then un-invited" survives — and so verified-email matching, which
 * only ever looks at `pending` rows, stops honouring it the moment this commits.
 * That second property is what makes this a real control rather than a tidy-up:
 * an address invited by mistake is not a co-host waiting to happen.
 */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("cohostInvitations"), reason: v.optional(v.string()) },
  returns: v.object({ status: cohostInvitationStatus }),
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) throw notFound("That invitation");

    const actor = await requireEventActor(ctx, invitation.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot do that right now.");
    }
    const input = parseInput(revokeCohostInviteInputSchema, args);

    requirePermission(toPermissionActor(actor.user, actor.role), "membership.revokeCohostInvite", {
      kind: "membership",
      targetRole: "cohost",
      isSelf: false,
      event: { state: actor.event.state },
    });

    if (invitation.status !== "pending") return { status: invitation.status };

    const now = Date.now();
    await ctx.db.patch(invitation._id, {
      status: "revoked",
      revokedAt: now,
      revokedByUserId: actor.user._id,
      ...(input.reason === undefined ? {} : { revokeReason: input.reason }),
      // Burn the link with the row. A revoked invitation must not be reachable
      // by the URL somebody already has in their inbox.
      token: undefined,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.cohostInviteRevoked,
      subjectType: "cohostInvitation",
      subjectId: invitation._id,
      actor: { userId: actor.user._id, role: actor.role },
      eventId: invitation.eventId,
      reason: input.reason,
      metadata: { invitedByUserId: invitation.invitedByUserId },
      now,
    });

    return { status: "revoked" as const };
  },
});

/* -------------------------------------------------------------------------- */
/* Remove a co-host                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Demote somebody who is already a co-host.
 *
 * Two writes, and both are needed. The membership is revoked, and **any pending
 * invitation to the same address is revoked with it** — otherwise the next time
 * that person signs in, matching finds the invitation, revives the membership it
 * correctly reactivates for a re-invited host, and the removal quietly undoes
 * itself. That interaction is the reason this is one mutation rather than "call
 * revoke and then tidy up".
 *
 * Owner only in practice, and by the matrix rather than by a role check here:
 * `membership.revoke` refuses `isSelf`, refuses an `owner` target, and refuses a
 * co-host acting on anybody who is not a `guest`.
 */
export const remove = mutation({
  args: { eventId: v.id("events"), userId: v.id("users"), reason: v.optional(v.string()) },
  returns: v.object({ revokedMembership: v.boolean(), revokedInvitations: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot do that right now.");
    }
    const input = parseInput(removeCohostInputSchema, args);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_user", (q) =>
        q.eq("eventId", args.eventId).eq("userId", args.userId),
      )
      .unique();
    if (!membership) throw notFound("That co-host");

    requirePermission(toPermissionActor(actor.user, actor.role), "membership.revoke", {
      kind: "membership",
      targetRole: membership.role,
      isSelf: membership.userId === actor.user._id,
      event: { state: actor.event.state },
    });

    const now = Date.now();
    const reason = input.reason ?? "Removed by the host.";
    let revokedMembership = false;

    if (membership.status === "active") {
      await ctx.db.patch(membership._id, {
        status: "revoked",
        revokedAt: now,
        revokedByUserId: actor.user._id,
        revokeReason: reason,
      });
      revokedMembership = true;

      // The seat is not the whole capability. A grant already issued is spent
      // against the grant, not against the membership — see
      // `expireGrantsForUser` — so a removal that leaves live grants behind is a
      // removal the removed person can still upload through.
      await expireGrantsForUser(ctx, args.eventId, args.userId, now);

      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.membershipRevoked,
        subjectType: "membership",
        subjectId: membership._id,
        actor: { userId: actor.user._id, role: actor.role },
        eventId: args.eventId,
        reason,
        metadata: { via: "cohostRemoval", revokedUserId: args.userId, role: membership.role },
        now,
      });
    }

    const target = await ctx.db.get(args.userId);
    let revokedInvitations = 0;
    if (target) {
      const invitations = (
        await ctx.db
          .query("cohostInvitations")
          .withIndex("by_event_and_email", (q) =>
            q.eq("eventId", args.eventId).eq("email", target.email.trim().toLowerCase()),
          )
          .collect()
      ).filter((row) => row.status === "pending");

      for (const invitation of invitations) {
        await ctx.db.patch(invitation._id, {
          status: "revoked",
          revokedAt: now,
          revokedByUserId: actor.user._id,
          revokeReason: reason,
          token: undefined,
        });
        await writeAuditEvent(ctx, {
          action: AUDIT_ACTIONS.cohostInviteRevoked,
          subjectType: "cohostInvitation",
          subjectId: invitation._id,
          actor: { userId: actor.user._id, role: actor.role },
          eventId: args.eventId,
          reason,
          metadata: { via: "cohostRemoval" },
          now,
        });
        revokedInvitations += 1;
      }
    }

    return { revokedMembership, revokedInvitations };
  },
});

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The host list: who is in, and who has been asked.
 *
 * Host-only via `membership.list`. Pending invitations carry the **address**,
 * because the host typed it and needs to see whether they typed it right — and
 * they are shown to hosts and to nobody else, which is why `membershipSchema` in
 * the contracts deliberately has no `invitedEmail` field.
 */
export const list = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    members: v.array(
      v.object({
        membershipId: v.id("memberships"),
        userId: v.id("users"),
        displayName: v.string(),
        role: eventRole,
        status: membershipStatus,
        joinedAt: v.number(),
      }),
    ),
    invitations: v.array(
      v.object({
        id: v.id("cohostInvitations"),
        email: v.string(),
        status: cohostInvitationStatus,
        expiresAt: v.number(),
        createdAt: v.number(),
      }),
    ),
    canInvite: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "membership.list", {
      kind: "membership",
      targetRole: "guest",
      isSelf: false,
      event: { state: actor.event.state },
    });

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();

    const members = [];
    for (const membership of memberships) {
      if (membership.status !== "active") continue;
      const member = await ctx.db.get(membership.userId);
      members.push({
        membershipId: membership._id,
        userId: membership.userId,
        // The same anonymisation `projectMedia` applies: an account on its way
        // out keeps its row and loses its name.
        displayName:
          member === null ||
          member.accountState === "deletionScheduled" ||
          member.accountState === "deleted"
            ? "Former guest"
            : member.displayName,
        role: membership.role,
        status: membership.status,
        joinedAt: membership.joinedAt,
      });
    }

    const invitations = (
      await ctx.db
        .query("cohostInvitations")
        .withIndex("by_event_and_status", (q) =>
          q.eq("eventId", args.eventId).eq("status", "pending"),
        )
        .collect()
    ).map((row) => ({
      id: row._id,
      email: row.email,
      status: row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }));

    // Not "is the caller an owner": the same predicate the mutation enforces, so
    // a console never offers a control the backend would refuse.
    const canInvite = actor.role === "owner" && actor.user.accountState === "active";

    return {
      members: members.sort((a, b) => a.joinedAt - b.joinedAt),
      // A co-host may see the host list; the pending address list is the owner's.
      invitations: actor.role === "owner" ? invitations : [],
      canInvite,
    };
  },
});
