import { v } from "convex/values";

import { query } from "./_generated/server";
import { isAdminEmail } from "./lib/config";
import { getCurrentUser } from "./lib/guards";

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
      accountState: user.accountState,
      isOrganiser: user.isOrganiser,
      // Recomputed from the allowlist rather than trusting the cached column.
      isGlobalAdmin: isAdminEmail(user.email),
    };
  },
});
