import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins/email-otp";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { authBaseUrl, isAdminEmail, trustedOrigins } from "./lib/config";
import { otpEmail, sendEmail } from "./lib/email";
import { emailOtpPolicyOptions, otpPurposeFor } from "./lib/otp";
import { socialProviderConfig } from "./lib/providers";

/* -------------------------------------------------------------------------- */
/* Component client + app-side user mirror                                    */
/* -------------------------------------------------------------------------- */

/**
 * Until `npx convex dev` runs against a real deployment, `convex codegen`
 * writes the *generic* `_generated/api.d.ts` (`AnyApi` / `AnyComponents`), whose
 * index access is `| undefined`. These two casts are what that costs; they
 * become no-ops once the precise API is generated, and neither weakens a check
 * that the generic types were performing anyway.
 */
const authFunctions = internal.auth as unknown as AuthFunctions;
const betterAuthComponent = components.betterAuth as unknown as Parameters<
  typeof createClient<DataModel>
>[0];

/**
 * The Better Auth component client.
 *
 * Better Auth keeps its own `user`, `session`, `account` and `verification`
 * tables inside the component. The application needs a row it can put an
 * `Id<"users">` foreign key on — memberships, media and audit rows all point at
 * one — so the trigger below mirrors the component's user into our `users`
 * table for the whole lifecycle.
 *
 * Mirroring on a trigger rather than lazily on first use matters because
 * queries cannot write: by the time any read path runs, the row exists.
 */
export const authComponent = createClient<DataModel>(betterAuthComponent, {
  authFunctions,
  triggers: {
    user: {
      onCreate: async (ctx, doc) => {
        const now = Date.now();
        const email = normaliseEmail(doc.email);
        await ctx.db.insert("users", {
          authId: doc._id,
          email,
          emailVerified: doc.emailVerified ?? false,
          displayName: doc.name?.trim() || defaultDisplayName(email),
          isPrivateRelayEmail: isPrivateRelayEmail(email),
          accountState: "active",
          // Private beta is invitation-only. Accepting an organiser invitation
          // flips this; nothing else may.
          isOrganiser: false,
          // Cached from the server-side allowlist — `isAdminEmail` stays the
          // authority on every check.
          isGlobalAdmin: isAdminEmail(email),
          createdAt: now,
          updatedAt: now,
        });
      },

      onUpdate: async (ctx, newDoc) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", newDoc._id))
          .unique();
        if (!user) return;

        const email = normaliseEmail(newDoc.email);
        await ctx.db.patch(user._id, {
          email,
          emailVerified: newDoc.emailVerified ?? user.emailVerified,
          displayName: newDoc.name?.trim() || user.displayName,
          isPrivateRelayEmail: isPrivateRelayEmail(email),
          isGlobalAdmin: isAdminEmail(email),
          updatedAt: Date.now(),
        });
      },

      onDelete: async (ctx, doc) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", doc._id))
          .unique();
        if (!user) return;

        // Soft-delete only. Media, memberships and audit rows still reference
        // this id, and the purge worker (P1) is what eventually resolves them.
        const now = Date.now();
        await ctx.db.patch(user._id, {
          accountState: "deleted",
          deletedAt: now,
          updatedAt: now,
        });
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/* -------------------------------------------------------------------------- */
/* Auth instance                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the Better Auth instance for a request.
 *
 * Providers are added **only when their environment variables are present**, so
 * a deployment with no Google client (or no Resend key) still boots, still
 * serves the endpoints it can, and fails with a specific message on the ones it
 * cannot. That is the difference between "Google sign-in is not configured" and
 * a 500 at the door on party night.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const options: BetterAuthOptions = {
    baseURL: authBaseUrl(),
    trustedOrigins: trustedOrigins(),
    database: authComponent.adapter(ctx),

    // PartyBooth has no passwords anywhere: organisers and web guests use email
    // OTP, app guests use Apple or Google.
    emailAndPassword: { enabled: false },

    user: {
      deleteUser: {
        // Apple requires in-app account deletion. The account moves to
        // `deletionScheduled` in our tables via the `onDelete` trigger.
        enabled: true,
      },
    },

    account: {
      accountLinking: {
        // A guest who signs in with Google on the web and Apple in the app is
        // one person. Only link on addresses the provider vouched for.
        enabled: true,
        trustedProviders: ["google", "apple"],
      },
    },

    socialProviders: socialProviderConfig(),

    plugins: [
      convex({ authConfig }),
      emailOTP({
        // Six digits, ten-minute expiry, five attempts, sixty-second resend
        // cooldown — see `lib/otp.ts`, which derives all of it from
        // `@partybooth/contracts`.
        ...emailOtpPolicyOptions(),
        sendVerificationOTP: async ({ email, otp, type }) => {
          const purpose = otpPurposeFor(type, email);
          const message = otpEmail({ code: otp, purpose });
          await sendEmail({ ...message, to: email });
        },
      }),
    ],
  };

  return betterAuth(options);
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function normaliseEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Apple's private relay. Such an address cannot receive an organiser
 * invitation, which is why PLAN.md gives those users an OTP path to verify a
 * real address instead.
 */
function isPrivateRelayEmail(email: string): boolean {
  return email.endsWith("@privaterelay.appleid.com");
}

/** A usable name before the user confirms one, e.g. "corey" from the address. */
function defaultDisplayName(email: string): string {
  const [local] = email.split("@");
  return local && local.length > 0 ? local : "Guest";
}
