import { requestAccountDeletionInputSchema, updateProfileInputSchema } from "@partybooth/contracts";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { scheduleAccountDeletion } from "./lib/account-deletion";
import { isAdminEmail } from "./lib/config";
import { applyVerifiedEmailMatching } from "./lib/email-matching";
import { forbidden } from "./lib/errors";
import { getCurrentUser, requirePermission, requireUser, toPermissionActor } from "./lib/guards";
import { requireActiveUser } from "./lib/guards";
import { parseInput } from "./lib/input";

/**
 * The signed-in user, shaped for a client.
 *
 * Returns `null` rather than throwing when nobody is signed in, so the web and
 * app shells can render a signed-out state without treating it as an error.
 * Deliberately narrow: no `authId`, no lock reason, nothing a client has no use
 * for.
 */
export const currentUser = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("users"),
      email: v.string(),
      emailVerified: v.boolean(),
      displayName: v.string(),
      avatarKey: v.optional(v.string()),
      onboardedAt: v.optional(v.number()),
      accountState: v.string(),
      isOrganiser: v.boolean(),
      isGlobalAdmin: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    return {
      id: user._id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      ...(user.avatarKey === undefined ? {} : { avatarKey: user.avatarKey }),
      // Absent means "has never confirmed a name", which is what both shells
      // read to decide whether to show the onboarding screen. `displayName`
      // cannot answer it — see the column's note in `schema.ts`.
      ...(user.onboardedAt === undefined ? {} : { onboardedAt: user.onboardedAt }),
      accountState: user.accountState,
      isOrganiser: user.isOrganiser,
      // Recomputed from the allowlist rather than trusting the cached column.
      isGlobalAdmin: isAdminEmail(user.email),
    };
  },
});

/**
 * Confirm the profile: the name a host sees, and — from Sprint 3 — the avatar.
 *
 * This is the **only** writer of `users.displayName` from a client. Both shells
 * used to go through Better Auth's `updateUser` and rely on the `user.onUpdate`
 * trigger to mirror the name across, which worked but left the column with two
 * authors: the human, and whatever the identity provider last said. That is not
 * a theoretical conflict — verifying an email fires `onUpdate`, and the guest
 * who typed "Sam" would quietly become "Samantha Smith" again. So the trigger
 * now defers to a confirmed name (see `auth.ts`) and the confirmation lands
 * here, where it can also carry `avatarKey`, which Better Auth has no field
 * for.
 *
 * `onboardedAt` is stamped on the first successful call and never moved. It is
 * the flag both clients read to decide whether to show the onboarding screen,
 * and it is what makes the trigger's deference above possible.
 *
 * Idempotent: a guest editing their name from Settings calls the same mutation,
 * and gets the same result minus the timestamp change.
 */
export const updateProfile = mutation({
  args: {
    displayName: v.string(),
    avatarKey: v.optional(v.string()),
  },
  returns: v.object({
    displayName: v.string(),
    avatarKey: v.optional(v.string()),
    onboardedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    // `requireActiveUser`, not `requireUser`: a locked or deletion-scheduled
    // account must not be able to rename itself in a host's moderation queue.
    const user = await requireActiveUser(ctx);
    // The contract's own schema, so the trimming and the length ceiling are the
    // ones the two clients showed the guest before they pressed the button.
    const input = parseInput(updateProfileInputSchema, {
      displayName: args.displayName,
      ...(args.avatarKey === undefined ? {} : { avatarKey: args.avatarKey }),
    });

    const now = Date.now();
    const onboardedAt = user.onboardedAt ?? now;

    await ctx.db.patch(user._id, {
      displayName: input.displayName,
      ...(input.avatarKey === undefined ? {} : { avatarKey: input.avatarKey }),
      onboardedAt,
      updatedAt: now,
    });

    return {
      displayName: input.displayName,
      ...(input.avatarKey === undefined
        ? user.avatarKey === undefined
          ? {}
          : { avatarKey: user.avatarKey }
        : { avatarKey: input.avatarKey }),
      onboardedAt,
    };
  },
});

/**
 * Re-run verified-email matching for the signed-in user.
 *
 * The Better Auth triggers in `auth.ts` already do this on sign-up and on any
 * profile change, which covers "invited yesterday, signs in today". This covers
 * the other order — "signed in last week, invited five minutes ago" — without
 * making the organiser wait for their co-host to sign out and back in. It is
 * idempotent: an invitation is consumed by being accepted, so a client is free
 * to call it on every app launch.
 */
export const refreshRoles = mutation({
  args: {},
  returns: v.object({
    isOrganiser: v.boolean(),
    organiserUnlocked: v.boolean(),
    cohostEventIds: v.array(v.id("events")),
  }),
  handler: async (ctx) => {
    const user = await requireActiveUser(ctx);
    const matched = await applyVerifiedEmailMatching(ctx, user);
    const fresh = await ctx.db.get(user._id);
    return {
      isOrganiser: fresh?.isOrganiser ?? user.isOrganiser,
      organiserUnlocked: matched.organiserUnlocked,
      cohostEventIds: matched.cohostEventIds,
    };
  },
});

/**
 * Delete this account, from inside the app.
 *
 * Apple requires it (guideline 5.1.1(v)) and it has to work for **both**
 * populations, which is why it is here and not behind an organiser-only route:
 * a guest who signed in with Apple at somebody else's party and an organiser who
 * runs three of them press the same button and get the same outcome.
 *
 * What that outcome is, precisely — PLAN.md, and it is not what "delete" usually
 * means:
 *
 * - the account moves to `deletionScheduled` **immediately** and loses access
 *   there and then, because `accountStateAllows` lets a deletion-scheduled
 *   account do nothing but view itself;
 * - a `deletionJobs` row records the intent and a due date thirty days out;
 * - submissions are **retained and anonymised**. The photographs belong to the
 *   party as much as to the person who took them, and a host who wakes up to a
 *   gallery with holes in it has been failed. `projectMedia` and `stats` show
 *   "Former guest" from the moment the state changes, so the attribution goes
 *   even though the picture does not.
 *
 * Nothing here moves an account to `deleted`. That is the P1 purge worker's
 * state, and keeping it out of reach is what makes the thirty-day restore window
 * real rather than nominal.
 *
 * `requireUser`, not `requireActiveUser`: a **locked** account must still be able
 * to delete itself — `NON_ACTIVE_ACCOUNT_ACTIONS` says so — and refusing here
 * would mean a suspended user has no way out, which is exactly the complaint
 * App Review is guarding against. `account.requestDeletion` is what draws the
 * line, and it refuses an account that is already scheduled or already purged.
 */
export const requestAccountDeletion = mutation({
  args: { reason: v.optional(v.string()) },
  returns: v.object({
    accountState: v.string(),
    scheduledAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const input = parseInput(requestAccountDeletionInputSchema, args);

    requirePermission(toPermissionActor(user, "guest"), "account.requestDeletion", {
      kind: "account",
      state: user.accountState,
      isSelf: true,
    });

    // Belt and braces against a future capability change: this mutation must
    // never be reachable for anybody else's account.
    if (user.accountState === "deleted") throw forbidden("This account no longer exists.");

    const result = await scheduleAccountDeletion(ctx, user, {
      requestedByUserId: user._id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });

    return {
      accountState: "deletionScheduled",
      scheduledAt: result.scheduledAt ?? null,
    };
  },
});
