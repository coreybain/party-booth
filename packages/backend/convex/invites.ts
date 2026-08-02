import {
  AUDIT_ACTIONS,
  normalizeEventCode,
  ROTATION_THROTTLED_MESSAGE,
  rotateInviteInputSchema,
  validateSpecificEventCode,
} from "@partybooth/contracts";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeEventAudit } from "./lib/audit";
import { forbidden, invalidInput, rateLimited } from "./lib/errors";
import { getActiveInviteVersion, isCodeTaken, mintInviteVersion } from "./lib/events";
import { requireEventActor, requirePermission, toPermissionActor } from "./lib/guards";
import { parseInput } from "./lib/input";
import { checkRotationThrottle, recordRotation } from "./lib/rotation_throttle";

/**
 * Invite versions: the six-digit code and the QR token, and rotating them.
 *
 * The rotation **UI** is Sprint 5. The model and this mutation land now because
 * everything else depends on the shape: joining resolves a credential to a
 * version and refuses a superseded one, and a rotation that was bolted on later
 * would have meant retrofitting that check into the one code path nobody wants
 * to touch twice.
 *
 * Rotation never edits the outgoing row. The old version is marked `revoked`
 * and a new one is inserted, so "which QR was on the wall" stays answerable and
 * a join against the old poster is rejected by the same check that rejects a
 * guessed code.
 */

export const rotate = mutation({
  args: {
    eventId: v.id("events"),
    /** `false` revokes every guest membership admitted under the old version. */
    keepExistingMemberships: v.optional(v.boolean()),
    /** Admin console only: rotate to a chosen code rather than a random one. */
    specificCode: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    inviteVersionId: v.id("inviteVersions"),
    version: v.number(),
    code: v.string(),
    token: v.string(),
    revokedMemberships: v.number(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);
    const input = parseInput(rotateInviteInputSchema, args);

    // A host whose own account is `locked` or `deletionScheduled` must not keep
    // rotating. `requireEventActor` resolves through `requireUser`, deliberately
    // — so this has to be checked here or not at all, exactly as `moderate` and
    // `requestUploadGrant` do it.
    if (actor.user.accountState !== "active") {
      throw forbidden("This account cannot rotate the invite right now.");
    }

    requirePermission(toPermissionActor(actor.user, actor.role), "event.rotateInvite", {
      kind: "event",
      state: actor.event.state,
    });

    /*
     * The rotation budget: five an hour, per event.
     *
     * Checked **after** the permission so that a stranger learns nothing from
     * the timing, and before anything is written so a refused rotation costs
     * nothing. It exists because the revoke path below writes one audit row per
     * guest it removes: without a ceiling, a held-down button turns a fifty-guest
     * party into an unbounded pile of writes during the evening the rotation is
     * supposed to be protecting. See `ROTATION_POLICY` in
     * `@partybooth/contracts/codes` for the arithmetic.
     */
    const now = Date.now();
    const budget = await checkRotationThrottle(ctx, actor.event._id, now);
    if (!budget.allowed) {
      throw rateLimited(ROTATION_THROTTLED_MESSAGE, budget.retryAfterMs);
    }

    let specificCode: string | undefined;
    if (input.specificCode !== undefined) {
      // PLAN.md scopes "rotate to a specific value" to the admin console, and
      // it is first on the cut list. A host picking their own number is how a
      // memorable-but-guessable code ends up on a poster.
      if (actor.role !== "globalAdmin") {
        throw forbidden("Only the admin console can rotate to a specific code.");
      }
      const validated = validateSpecificEventCode(input.specificCode);
      if (!validated.ok) {
        throw invalidInput(
          validated.reason === "format"
            ? "A join code is six digits."
            : "That code is too easy to guess. Pick another.",
        );
      }
      if (await isCodeTaken(ctx, validated.code, { ignoreEventId: actor.event._id })) {
        throw invalidInput("That code is already in use by another event.");
      }
      // `ignoreEventId` above deliberately excuses this event's own outgoing
      // code from the collision check — otherwise no specific-code rotation
      // could ever run. That exemption is exactly why the same value has to be
      // refused here: rotating 482913 → 482913 revokes the version, mints a new
      // one, tells the host the poster is dead, and leaves the six digits on it
      // working. `mintInviteVersion` refuses it too; this is the sentence a
      // human reads.
      const current = await getActiveInviteVersion(ctx, actor.event);
      if (current && normalizeEventCode(current.code) === validated.code) {
        throw invalidInput(
          "That is the code you are rotating away from. Pick a different one, or rotate to a random code.",
        );
      }
      specificCode = validated.code;
    }

    const result = await mintInviteVersion(ctx, {
      event: actor.event,
      createdByUserId: actor.user._id,
      keepExistingMemberships: input.keepExistingMemberships,
      ...(specificCode === undefined ? {} : { specificCode }),
      reason: input.reason,
      now,
    });

    await writeEventAudit(ctx, {
      action: AUDIT_ACTIONS.inviteRotated,
      event: actor.event,
      actor: { user: actor.user, role: actor.role },
      // `event.invite_rotated` is on AUDIT_ACTIONS_REQUIRING_REASON, so the
      // writer throws without one. Rotating from the host console has an
      // implicit reason; the admin console collects an explicit one.
      reason: input.reason ?? "Invite rotated by a host.",
      metadata: {
        version: result.version,
        previousVersion: result.previousVersion,
        keptMemberships: input.keepExistingMemberships,
        revokedMemberships: result.revokedMembershipIds.length,
        // Never the code itself: audit rows are read in bulk and by more people
        // than the host list.
        specific: specificCode !== undefined,
        // Which axis the rotation came from. A host rotating because the sign
        // walked off and an admin rotating because of a complaint are the same
        // write and very different incidents.
        via: actor.role === "globalAdmin" ? "adminConsole" : "hostConsole",
      },
      now,
    });

    // Charged only once the rotation has actually happened — the budget counts
    // successes, so a refusal above costs the host nothing.
    await recordRotation(ctx, actor.event._id, now);

    return {
      inviteVersionId: result.inviteVersionId,
      version: result.version,
      code: result.code,
      token: result.token,
      revokedMemberships: result.revokedMembershipIds.length,
    };
  },
});

/**
 * The current code and QR token for an event.
 *
 * Host-only, via `event.viewInviteCode` — a guest with the code can re-share
 * the party to anyone, which is the thing rotation exists to undo.
 *
 * A global admin gets the code and not the token. The admin rotation form needs
 * the current six digits to say what it is replacing; it does not need the
 * durable 160-bit QR bearer token, so that higher-value credential is omitted.
 * If an admin legitimately presents either current credential through the join
 * flow, they are admitted as an event guest like any other invitee.
 */
export const current = query({
  args: { eventId: v.id("events") },
  returns: v.union(
    v.null(),
    v.object({
      inviteVersionId: v.id("inviteVersions"),
      version: v.number(),
      code: v.string(),
      /** Absent for a global admin — see the note above. */
      token: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireEventActor(ctx, args.eventId);

    requirePermission(toPermissionActor(actor.user, actor.role), "event.viewInviteCode", {
      kind: "event",
      state: actor.event.state,
    });

    const version = await getActiveInviteVersion(ctx, actor.event);
    if (!version) return null;

    return {
      inviteVersionId: version._id,
      version: version.version,
      code: version.code,
      ...(actor.role === "globalAdmin" ? {} : { token: version.token }),
      createdAt: version.createdAt,
    };
  },
});
