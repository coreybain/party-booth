import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { registerOtpSendFor } from "./lib/otp-throttle";

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
    const decision = await registerOtpSendFor(ctx, args.email, args.now ?? Date.now());
    return decision.allowed
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, reason: decision.reason, retryAfterMs: decision.retryAfterMs };
  },
});
