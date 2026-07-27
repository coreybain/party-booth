import { canSendOtp, registerOtpSend, type OtpSendState } from "@partybooth/contracts";
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

/**
 * The per-address OTP send throttle.
 *
 * PLAN.md fixes a 60-second resend cooldown and TODO.md Sprint 2 asks for
 * "enumeration protection" on the OTP path. Neither can be delegated to Better
 * Auth here:
 *
 *  - its global rate limiter is off unless `NODE_ENV === "production"`, and
 *    Convex never sets `NODE_ENV`;
 *  - its default storage is an in-memory `Map` scoped to one isolate, and
 *    Convex recycles and parallelises isolates, so the counters are not shared.
 *
 * `createAuth` still turns Better Auth's limiter on with database storage — two
 * brakes are better than one — but *this* mutation is the one that is
 * guaranteed to hold. It runs inside a Convex mutation, so the read-decide-write
 * is transactional and two simultaneous requests cannot both pass.
 *
 * The decision depends only on the send history for the address, never on
 * whether an account exists, so the response is identical for a real address
 * and an invented one.
 */
export const registerSend = internalMutation({
  args: {
    /** Trimmed and lower-cased by the caller; normalised again here anyway. */
    email: v.string(),
    /** Injectable clock, for tests. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    allowed: v.boolean(),
    reason: v.optional(v.union(v.literal("cooldown"), v.literal("rateLimited"))),
    retryAfterMs: v.number(),
  }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const now = args.now ?? Date.now();

    const existing = await ctx.db
      .query("otpChallenges")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    const state: OtpSendState | undefined = existing
      ? {
          lastSentAt: existing.lastSentAt,
          sendCount: existing.sendCount,
          windowStartedAt: existing.windowStartedAt,
        }
      : undefined;

    const decision = canSendOtp(state, now);
    if (!decision.allowed) {
      // Deliberately no write: a refused send must not extend the cooldown, or
      // a client that retries in a loop would never be let through again.
      return { allowed: false, reason: decision.reason, retryAfterMs: decision.retryAfterMs };
    }

    const next = registerOtpSend(state, now);
    if (existing) {
      await ctx.db.patch(existing._id, { ...next, updatedAt: now });
    } else {
      await ctx.db.insert("otpChallenges", { email, ...next, updatedAt: now });
    }

    return { allowed: true, retryAfterMs: 0 };
  },
});
