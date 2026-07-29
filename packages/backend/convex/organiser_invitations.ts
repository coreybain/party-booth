import { normalizeInviteToken } from "@partybooth/contracts";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalQuery, query } from "./_generated/server";
import { createAuth } from "./auth";
import { siteUrl } from "./lib/config";

const ORGANISER_INVITE_TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{39}$/;

const organiserInvitationFunctions = internal.organiser_invitations as unknown as {
  pendingByToken: FunctionReference<
    "query",
    "internal",
    { token: string },
    { email: string; token: string } | null
  >;
};

type MagicLinkApi = {
  signInMagicLink(input: {
    body: {
      email: string;
      callbackURL: string;
      errorCallbackURL: string;
      metadata: Record<string, unknown>;
    };
    headers: Headers;
  }): Promise<{ status: boolean }>;
};

/**
 * Resolve an organiser invitation without disclosing the invited address.
 *
 * The token is high entropy and arrives in email, but it still should not turn
 * a public query into an address lookup. The verified email used at sign-in is
 * what ultimately claims the invitation in `lib/email_matching.ts`.
 */
export const preview = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pending"), v.literal("accepted")),
      invitedByName: v.string(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const token = normalizeInviteToken(args.token);
    if (!ORGANISER_INVITE_TOKEN_PATTERN.test(token)) return null;

    const invitation = await ctx.db
      .query("organiserInvitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invitation) return null;
    if (invitation.status === "revoked" || invitation.status === "expired") return null;
    if (invitation.status === "pending" && invitation.expiresAt <= Date.now()) return null;

    const inviter = await ctx.db.get(invitation.invitedByUserId);
    return {
      status: invitation.status,
      invitedByName: inviter?.displayName ?? "The PartyBooth team",
      expiresAt: invitation.expiresAt,
    };
  },
});

export const pendingByToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ email: v.string(), token: v.string() })),
  handler: async (ctx, args) => {
    const token = normalizeInviteToken(args.token);
    if (!ORGANISER_INVITE_TOKEN_PATTERN.test(token)) return null;
    const invitation = await ctx.db
      .query("organiserInvitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= Date.now()) {
      return null;
    }
    return { email: invitation.email, token: invitation.token };
  },
});

export const pendingTokenByEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.null(), v.object({ token: v.string() })),
  handler: async (ctx, args) => {
    const invitation = (
      await ctx.db
        .query("organiserInvitations")
        .withIndex("by_email_and_status", (q) =>
          q.eq("email", args.email.trim().toLowerCase()).eq("status", "pending"),
        )
        .collect()
    ).find((candidate) => candidate.expiresAt > Date.now());
    return invitation ? { token: invitation.token } : null;
  },
});

/**
 * Turn the product's organiser token into a standard Better Auth magic link.
 *
 * The address never reaches the browser. A valid, pending token selects it,
 * Better Auth stages a one-use hashed verification record, and the browser
 * immediately visits the normal verification endpoint through the first-party
 * Next.js proxy.
 */
export const prepare = action({
  args: { token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({ ok: v.literal(true), verifyPath: v.string() }),
  ),
  handler: async (ctx, args) => {
    const invitation = await ctx.runQuery(organiserInvitationFunctions.pendingByToken, {
      token: args.token,
    });
    if (!invitation) return { ok: false as const };

    const callbackURL = "/invite/organiser/complete";
    const errorCallbackURL = "/?invite=invalid";
    const magicLinkApi = createAuth(ctx).api as unknown as MagicLinkApi;
    await magicLinkApi.signInMagicLink({
      body: {
        email: invitation.email,
        callbackURL,
        errorCallbackURL,
        metadata: { partyboothOrganiserInvite: true },
      },
      headers: new Headers({ origin: new URL(siteUrl()).origin }),
    });

    const search = new URLSearchParams({
      token: invitation.token,
      callbackURL,
      errorCallbackURL,
    });
    return { ok: true as const, verifyPath: `/api/auth/magic-link/verify?${search.toString()}` };
  },
});
