import {
  AUDIT_ACTIONS,
  confirmEmailVerificationInputSchema,
  constantTimeEqual,
  generateOtpCode,
  OTP_POLICY,
  OTP_SEND_DENIAL_MESSAGES,
  requestEmailVerificationInputSchema,
} from "@partybooth/contracts";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { applyVerifiedEmailMatching } from "./lib/email-matching";
import { otpEmail, sendEmail } from "./lib/email";
import { invalidInput, notConfigured, rateLimited, unauthenticated } from "./lib/errors";
import { requireActiveUser, requireUser } from "./lib/guards";
import { sha256Hex } from "./lib/hash";
import { parseInput } from "./lib/input";
import { registerOtpSendFor } from "./lib/otp-throttle";
import { userEmailStatus } from "./lib/validators";

/**
 * Proving a **second** email address.
 *
 * One case needs this, from PLAN.md: a guest who signs in with Apple gets a
 * `@privaterelay.appleid.com` address. An organiser invitation or a co-host
 * invite can never reach it, so verified-email matching has nothing to match
 * and they are permanently stuck as a guest. They add a real address here,
 * prove it with the same six-digit code as everything else, and matching runs
 * against both.
 *
 * The code is stored **hashed** and compared in constant time — same posture as
 * Better Auth's `storeOTP: "hashed"` for sign-in codes — with the same
 * ten-minute expiry and five-guess budget from `OTP_POLICY`, and it shares the
 * per-address send counter in `otpChallenges` so this cannot become an
 * unthrottled way to make PartyBooth email a stranger.
 *
 * This is deliberately *not* a second sign-in path. A verified address here
 * grants roles; it never authenticates anybody.
 */

const CHALLENGE_FAILURE = "That code is not valid, or it has expired. Ask for a new one.";

/**
 * Until `npx convex dev` runs against a real deployment, codegen writes the
 * *generic* `api.d.ts`, where index access is `| undefined` and untyped. Same
 * cast, same reason, as the two in `auth.ts`; it becomes a no-op once the
 * precise API is generated.
 */
type IssueChallengeResult =
  | { allowed: true; code: string }
  | { allowed: false; reason: "cooldown" | "rateLimited"; retryAfterMs: number };

const emailFunctions = internal.emails as unknown as {
  issueChallenge: FunctionReference<
    "mutation",
    "internal",
    { authId: string; email: string; now?: number },
    IssueChallengeResult
  >;
};

/* -------------------------------------------------------------------------- */
/* Issue                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mint the challenge and hand the plaintext code back to the caller, which is
 * the action immediately above it — the only way to get a code out of here.
 * Nothing persists it: the row holds the digest.
 */
export const issueChallenge = internalMutation({
  args: { authId: v.string(), email: v.string(), now: v.optional(v.number()) },
  returns: v.union(
    v.object({ allowed: v.literal(true), code: v.string() }),
    v.object({
      allowed: v.literal(false),
      reason: v.union(v.literal("cooldown"), v.literal("rateLimited")),
      retryAfterMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user) throw unauthenticated();
    if (user.accountState !== "active") {
      throw invalidInput("This account cannot verify an email address right now.");
    }

    const { email } = parseInput(requestEmailVerificationInputSchema, { email: args.email });
    const now = args.now ?? Date.now();

    const decision = await registerOtpSendFor(ctx, email, now);
    if (!decision.allowed) {
      return {
        allowed: false as const,
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      };
    }

    const code = generateOtpCode();
    const codeHash = await sha256Hex(code);

    const existing = await ctx.db
      .query("userEmails")
      .withIndex("by_user_and_email", (q) => q.eq("userId", user._id).eq("email", email))
      .unique();

    const fields = {
      status: "pending" as const,
      codeHash,
      expiresAt: now + OTP_POLICY.ttlMs,
      // A fresh code gets a fresh budget; the old one is gone either way.
      attempts: 0,
      updatedAt: now,
    };

    if (existing) {
      // Re-verifying an address that is already proven is harmless and keeps
      // the flow uniform, so it is allowed rather than special-cased.
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("userEmails", {
        userId: user._id,
        email,
        ...fields,
        createdAt: now,
      });
    }

    return { allowed: true as const, code };
  },
});

/**
 * Send a verification code to an address the signed-in user wants to claim.
 *
 * An **action**, because emailing needs `fetch` and mutations do not have it.
 * The identity is read here rather than assumed downstream, so the internal
 * mutation is handed an `authId` it can resolve for itself.
 */
export const requestVerification = action({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw unauthenticated();

    const issued = await ctx.runMutation(emailFunctions.issueChallenge, {
      authId: identity.subject,
      email: args.email,
    });

    if (!issued.allowed) {
      throw rateLimited(OTP_SEND_DENIAL_MESSAGES[issued.reason], issued.retryAfterMs);
    }

    const message = otpEmail({ code: issued.code, purpose: "emailVerification" });
    const result = await sendEmail({ ...message, to: args.email });
    if (!result.ok) {
      // The console sender refuses to fake success outside development, so a
      // deployment with no Resend key says so instead of silently swallowing
      // the code the user is now waiting for.
      throw notConfigured("Email delivery");
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Check a code and, on success, run verified-email matching.
 *
 * Failure is a **return value, not an exception**, and that is not a style
 * choice: a Convex mutation that throws rolls its own writes back, so a handler
 * that incremented the attempt counter and then threw would hand out an
 * unlimited guess budget. The wrong-code path has to commit, therefore it has
 * to return.
 */
export const confirmVerification = mutation({
  args: { email: v.string(), code: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      organiserUnlocked: v.boolean(),
      cohostEventIds: v.array(v.id("events")),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("invalid"), v.literal("tooManyAttempts")),
      message: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(confirmEmailVerificationInputSchema, args);
    const now = Date.now();

    const row = await ctx.db
      .query("userEmails")
      .withIndex("by_user_and_email", (q) => q.eq("userId", user._id).eq("email", input.email))
      .unique();

    // One message for "no such challenge", "expired" and "wrong code", for the
    // same reason join has one: otherwise this endpoint says which addresses
    // are mid-verification.
    if (!row?.codeHash || row.expiresAt === undefined || row.expiresAt <= now) {
      return { ok: false as const, reason: "invalid" as const, message: CHALLENGE_FAILURE };
    }

    if (row.attempts >= OTP_POLICY.maxAttempts) {
      return {
        ok: false as const,
        reason: "tooManyAttempts" as const,
        message: "Too many wrong codes. Ask for a new one.",
      };
    }

    if (!constantTimeEqual(row.codeHash, await sha256Hex(input.code))) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1, updatedAt: now });
      return { ok: false as const, reason: "invalid" as const, message: CHALLENGE_FAILURE };
    }

    await ctx.db.patch(row._id, {
      status: "verified",
      verifiedAt: now,
      // Burn the code: a verified row must not hold a usable credential.
      codeHash: undefined,
      expiresAt: undefined,
      attempts: 0,
      updatedAt: now,
    });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.accountEmailVerified,
      subjectType: "user",
      subjectId: user._id,
      actor: { userId: user._id },
      // No address: an audit row must not become a directory.
      now,
    });

    const fresh = await ctx.db.get(user._id);
    const matched = await applyVerifiedEmailMatching(ctx, fresh ?? user, { now });

    return {
      ok: true as const,
      organiserUnlocked: matched.organiserUnlocked,
      cohostEventIds: matched.cohostEventIds,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/** The addresses this account has claimed, and whether each is proven. */
export const myEmails = query({
  args: {},
  returns: v.array(
    v.object({
      email: v.string(),
      status: userEmailStatus,
      verifiedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db
      .query("userEmails")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows.map((row) => ({
      email: row.email,
      status: row.status,
      ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
    }));
  },
});
