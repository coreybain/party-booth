import { AUDIT_ACTIONS } from "@partybooth/contracts";
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { isDemoAddress } from "./lib/config";
import { registerOtpSendFor } from "./lib/otp_throttle";

/**
 * The per-address OTP send throttle.
 *
 * PLAN.md fixes a 15-second resend cooldown and TODO.md Sprint 2 asks for
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

/**
 * Record that the App Review demo credential was used to request a code.
 *
 * The fixed-OTP path is the one credential in the product that does not depend
 * on somebody controlling a mailbox, so the only thing standing between it and
 * an unnoticed back door is that every use is countable afterwards. Its own
 * audit action (`auth.demo_sign_in`) rather than a flag on a normal sign-in,
 * because "did anyone use the reviewer account during the party?" has to be one
 * query, not a scan with a filter.
 *
 * It re-checks `isDemoAddress` rather than trusting its caller. This is an
 * internal mutation and the caller is `auth.ts`, but an audit row asserting a
 * bypass happened is exactly the row that must not be forgeable by a future
 * caller passing the wrong argument.
 */
export const recordDemoSignIn = internalMutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isDemoAddress(args.email)) return null;

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.demoSignIn,
      subjectType: "platform",
      // No address and no code. The action name says which account this was, and
      // the code is a live credential for as long as the variables are set.
      metadata: { stage: "codeIssued" },
    });
    return null;
  },
});
