import {
  canSendOtp,
  registerOtpSend,
  type OtpSendDecision,
  type OtpSendState,
} from "@partybooth/contracts";

import type { MutationCtx } from "../_generated/server";

/**
 * The per-address OTP send throttle, as a plain function.
 *
 * `convex/otp.ts` wraps it in the internal mutation Better Auth calls before it
 * emails a sign-in code; `convex/emails.ts` calls it directly when issuing a
 * verification code for a second address. One counter covers both, which is the
 * point: otherwise "verify another email" would be an unthrottled way to make
 * PartyBooth send mail to an arbitrary address.
 *
 * All of the policy is in `@partybooth/contracts` and pure. This only reads and
 * writes the row, inside a mutation, so the read-decide-write is transactional
 * and two simultaneous taps cannot both pass.
 */
export async function registerOtpSendFor(
  ctx: MutationCtx,
  rawEmail: string,
  now: number,
): Promise<OtpSendDecision> {
  const email = rawEmail.trim().toLowerCase();

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
  // Deliberately no write on a refusal: extending the cooldown every time a
  // looping client retries would lock the address out permanently.
  if (!decision.allowed) return decision;

  const next = registerOtpSend(state, now);
  if (existing) {
    await ctx.db.patch(existing._id, { ...next, updatedAt: now });
  } else {
    await ctx.db.insert("otpChallenges", { email, ...next, updatedAt: now });
  }

  return decision;
}
