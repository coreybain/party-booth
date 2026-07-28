import { AUDIT_ACTIONS } from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditEvent } from "./audit";

/**
 * Verified-email matching.
 *
 * PLAN.md: "Verified-email matching unlocks organiser/co-host features; Apple
 * private-relay users can verify an organiser email via OTP." This is that,
 * and it runs on every authentication rather than only at sign-up, because the
 * invitation is very often issued *after* the person already has an account.
 *
 * The word doing the work is **verified**. An address is only matched when a
 * provider vouched for it (`users.emailVerified`) or its owner proved it with a
 * six-digit code (`userEmails.status === "verified"`). Matching an unverified
 * address would mean anyone who can type someone else's email into a sign-up
 * form inherits their co-host seat.
 *
 * The whole function is idempotent: an invitation is consumed by moving it to
 * `accepted`, so a second pass finds nothing to do.
 */

export interface MatchingResult {
  /** Addresses that were considered. */
  emails: string[];
  /** `true` when this pass flipped the account to organiser. */
  organiserUnlocked: boolean;
  /** Events where this pass granted or upgraded a co-host membership. */
  cohostEventIds: Id<"events">[];
}

export interface MatchingOptions {
  now?: number | undefined;
}

/**
 * Every address this user has proven, lower-cased and de-duplicated.
 *
 * The account's own address counts only when the provider marked it verified —
 * Better Auth sets that for Google and Apple, and for a completed email-OTP
 * sign-in.
 */
export async function verifiedEmailsFor(ctx: MutationCtx, user: Doc<"users">): Promise<string[]> {
  const emails = new Set<string>();
  if (user.emailVerified && user.email) emails.add(user.email.trim().toLowerCase());

  const extra = await ctx.db
    .query("userEmails")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const row of extra) {
    if (row.status === "verified") emails.add(row.email);
  }
  return [...emails];
}

export async function applyVerifiedEmailMatching(
  ctx: MutationCtx,
  user: Doc<"users">,
  options: MatchingOptions = {},
): Promise<MatchingResult> {
  const now = options.now ?? Date.now();
  const emails = await verifiedEmailsFor(ctx, user);

  const result: MatchingResult = { emails, organiserUnlocked: false, cohostEventIds: [] };

  // A locked or deletion-scheduled account gains nothing from matching, and
  // handing it a co-host seat it cannot use would only confuse the audit log.
  if (user.accountState !== "active") return result;

  for (const email of emails) {
    result.organiserUnlocked =
      (await matchOrganiserInvitations(ctx, user, email, now)) || result.organiserUnlocked;
    result.cohostEventIds.push(...(await matchCohostInvitations(ctx, user, email, now)));
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Organiser invitations                                                      */
/* -------------------------------------------------------------------------- */

async function matchOrganiserInvitations(
  ctx: MutationCtx,
  user: Doc<"users">,
  email: string,
  now: number,
): Promise<boolean> {
  const pending = await ctx.db
    .query("organiserInvitations")
    .withIndex("by_email_and_status", (q) => q.eq("email", email).eq("status", "pending"))
    .collect();

  let unlocked = false;

  for (const invitation of pending) {
    if (invitation.expiresAt <= now) {
      await ctx.db.patch(invitation._id, { status: "expired" });
      continue;
    }

    await ctx.db.patch(invitation._id, {
      status: "accepted",
      acceptedAt: now,
      acceptedByUserId: user._id,
    });

    if (!user.isOrganiser) {
      await ctx.db.patch(user._id, { isOrganiser: true, updatedAt: now });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.organiserInviteAccepted,
      subjectType: "organiserInvitation",
      subjectId: invitation._id,
      actor: { userId: user._id },
      // No address in the metadata: audit rows are read in bulk and this one
      // would put a mailing list in them.
      metadata: { invitedByUserId: invitation.invitedByUserId },
      now,
    });
    unlocked = true;
  }

  return unlocked;
}

/* -------------------------------------------------------------------------- */
/* Co-host invitations                                                        */
/* -------------------------------------------------------------------------- */

async function matchCohostInvitations(
  ctx: MutationCtx,
  user: Doc<"users">,
  email: string,
  now: number,
): Promise<Id<"events">[]> {
  const pending = await ctx.db
    .query("cohostInvitations")
    .withIndex("by_email_and_status", (q) => q.eq("email", email).eq("status", "pending"))
    .collect();

  const elevated: Id<"events">[] = [];

  for (const invitation of pending) {
    if (invitation.expiresAt <= now) {
      await ctx.db.patch(invitation._id, { status: "expired" });
      continue;
    }

    const event = await ctx.db.get(invitation.eventId);
    // An event on its way out does not hand out new host seats.
    if (!event || event.state === "deletionScheduled") {
      await ctx.db.patch(invitation._id, { status: "expired" });
      continue;
    }

    await ctx.db.patch(invitation._id, {
      status: "accepted",
      acceptedAt: now,
      acceptedByUserId: user._id,
    });

    // The owner is already senior to a co-host; accepting is a no-op for them.
    if (event.ownerUserId === user._id) continue;

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_user", (q) => q.eq("eventId", event._id).eq("userId", user._id))
      .unique();

    if (existing) {
      if (existing.role === "owner") continue;
      // A revoked membership is deliberately revived here: the host has just
      // asked for this person by address, which is a newer decision than the
      // removal it overrides.
      //
      // `revokedByRotation` is cleared **with** the rest, and leaving it behind
      // was a live escalation. The flag means "swept by a rotation and not since
      // re-decided", and `join.evaluateCredential` lets a sweep-revoked row back
      // in on a fresh scan. A row that had once been swept, then re-invited as a
      // co-host, then deliberately removed, still carried `true` — so the
      // removed co-host could scan the QR and walk back in. Every field that
      // records *why* a membership was revoked has to go when the membership
      // stops being revoked, or the next decision inherits the last one's
      // reasoning.
      await ctx.db.patch(existing._id, {
        role: "cohost",
        status: "active",
        revokedAt: undefined,
        revokedByUserId: undefined,
        revokeReason: undefined,
        revokedByRotation: undefined,
      });
    } else {
      const membershipId = await ctx.db.insert("memberships", {
        eventId: event._id,
        userId: user._id,
        role: "cohost",
        status: "active",
        invitedEmail: email,
        joinedAt: now,
      });
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.membershipCreated,
        subjectType: "membership",
        subjectId: membershipId,
        actor: { userId: user._id, role: "cohost" },
        eventId: event._id,
        metadata: { via: "cohostInvite", role: "cohost" },
        now,
      });
    }

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.cohostInviteAccepted,
      subjectType: "membership",
      subjectId: invitation._id,
      actor: { userId: user._id, role: "cohost" },
      eventId: event._id,
      metadata: { invitedByUserId: invitation.invitedByUserId },
      now,
    });

    elevated.push(event._id);
  }

  return elevated;
}

/* -------------------------------------------------------------------------- */
/* Issuing a co-host invitation                                               */
/* -------------------------------------------------------------------------- */

/** How long a co-host invitation stays open. */
export const COHOST_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface CreateCohostInvitationParams {
  event: Doc<"events">;
  email: string;
  invitedByUserId: Id<"users">;
  now?: number | undefined;
}

/**
 * Record the intent to make an address a co-host.
 *
 * The organiser-facing mutation and the invitation email are Sprint 5; this is
 * the write it will make, factored out now so that matching has something real
 * to match and so the two halves cannot be built against different assumptions.
 * Re-inviting an address that is already pending refreshes the expiry rather
 * than stacking a second row.
 */
export async function createCohostInvitation(
  ctx: MutationCtx,
  params: CreateCohostInvitationParams,
): Promise<Id<"cohostInvitations">> {
  const now = params.now ?? Date.now();
  const email = params.email.trim().toLowerCase();

  const existing = await ctx.db
    .query("cohostInvitations")
    .withIndex("by_event_and_email", (q) => q.eq("eventId", params.event._id).eq("email", email))
    .collect();

  const open = existing.find((row) => row.status === "pending");
  if (open) {
    await ctx.db.patch(open._id, { expiresAt: now + COHOST_INVITATION_TTL_MS });
    return open._id;
  }

  return await ctx.db.insert("cohostInvitations", {
    eventId: params.event._id,
    email,
    status: "pending",
    invitedByUserId: params.invitedByUserId,
    expiresAt: now + COHOST_INVITATION_TTL_MS,
    createdAt: now,
  });
}
