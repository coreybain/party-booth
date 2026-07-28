import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { OTP_SEND_DENIAL_MESSAGES, type OtpSendDenial } from "@partybooth/contracts";
import { serverEnv } from "@partybooth/env/server";
import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { FunctionReference } from "convex/server";

import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import authConfig from "./auth.config";
import { scheduleAccountDeletion } from "./lib/account-deletion";
import { applyVerifiedEmailMatching } from "./lib/email-matching";
import { authBaseUrl, isAdminEmail, trustedOrigins } from "./lib/config";
import { otpEmail, sendEmail } from "./lib/email";
import { emailOtpPolicyOptions, otpPurposeFor } from "./lib/otp";
import { resolveDisplayName } from "./lib/profile";
import { socialProviderConfig } from "./lib/providers";
import { captureError } from "./lib/sentry";

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

/** The OTP send throttle in `convex/otp.ts`. Same cast, same reason. */
const otpFunctions = internal.otp as unknown as {
  registerSend: FunctionReference<
    "mutation",
    "internal",
    { email: string; now?: number },
    { allowed: boolean; reason?: OtpSendDenial; retryAfterMs: number }
  >;
};

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
        try {
          const now = Date.now();
          const email = normaliseEmail(doc.email);
          const userId = await ctx.db.insert("users", {
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

          // Verified-email matching, run at the earliest possible moment: an
          // organiser invited last week signs in and is already an organiser on
          // the first screen, rather than after a refresh nobody thinks to do.
          await runEmailMatching(ctx, userId, now);
        } catch (error) {
          // A failed mirror leaves a Better Auth user with no application row,
          // so every guard treats them as signed out. That is a silent, total
          // outage for that account unless it is reported.
          captureError({ scope: "auth.trigger.onCreate", error });
          throw error;
        }
      },

      onUpdate: async (ctx, newDoc) => {
        try {
          const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", newDoc._id))
            .unique();
          if (!user) return;

          const now = Date.now();
          const email = normaliseEmail(newDoc.email);
          await ctx.db.patch(user._id, {
            email,
            emailVerified: newDoc.emailVerified ?? user.emailVerified,
            // A name the human confirmed themselves outranks the provider's —
            // see `lib/profile.ts`, which is where that rule is stated and
            // tested.
            displayName: resolveDisplayName({
              current: user.displayName,
              providerName: newDoc.name,
              onboardedAt: user.onboardedAt,
            }),
            isPrivateRelayEmail: isPrivateRelayEmail(email),
            isGlobalAdmin: isAdminEmail(email),
            updatedAt: now,
          });

          // An address that has just become verified — or has just changed —
          // may match an invitation that could not be matched before.
          await runEmailMatching(ctx, user._id, now);
        } catch (error) {
          captureError({ scope: "auth.trigger.onUpdate", error });
          throw error;
        }
      },

      /**
       * Better Auth's `deleteUser` removes its own row; ours does **not**
       * follow it to `deleted`.
       *
       * PLAN.md is explicit: an account that asks to be deleted moves to
       * `deletionScheduled` and loses access immediately, and the 30-day purge
       * is post-launch. Going straight to `deleted` here would skip the
       * `deletionJobs` record, skip the audit row, and — because
       * `deletionScheduled → active` is the only restore path in the account
       * state machine — make the restore window unreachable. Apple requires the
       * in-app delete button; it does not require it to be irreversible.
       */
      onDelete: async (ctx, doc) => {
        try {
          const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", doc._id))
            .unique();
          if (!user) return;

          await scheduleAccountDeletion(ctx, user);
        } catch (error) {
          captureError({ scope: "auth.trigger.onDelete", error });
          throw error;
        }
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

    /**
     * Passed explicitly so that `@partybooth/env`'s validation (present, ≥ 32
     * characters) is what gates boot.
     *
     * Left unset, Better Auth resolves the secret itself and falls back to a
     * hard-coded, publicly-known constant. Its own guard against that is
     * `NODE_ENV === "production"`, and **Convex never sets `NODE_ENV`** — so a
     * deployment with a missing or mistyped `BETTER_AUTH_SECRET` would boot
     * happily and sign every session cookie and Convex identity JWT with a
     * value anyone can read off npm. Reading it here means a misconfigured
     * deployment fails loudly at the first auth request instead.
     */
    secret: serverEnv.BETTER_AUTH_SECRET,

    /**
     * Better Auth's limiter defaults to `enabled: isProduction`, which is
     * always false in Convex, and to in-memory storage, which Convex's recycled
     * isolates do not share. Both are stated explicitly.
     *
     * `"database"` is the component's own `rateLimit` table, so the counters
     * survive an isolate being recycled. This is defence in depth only — the
     * OTP send ceiling that actually has to hold is enforced transactionally in
     * `convex/otp.ts`, below.
     */
    rateLimit: {
      enabled: true,
      storage: "database",
    },

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
          await assertOtpSendAllowed(ctx, email);
          const purpose = otpPurposeFor(type, email);
          const message = otpEmail({ code: otp, purpose });
          const result = await sendEmail({ ...message, to: email });
          if (!result.ok) {
            // The console sender refuses to fake a success in a real
            // deployment, so this is how "we couldn't email you" surfaces
            // instead of a silent "check your email".
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "We could not send that code. Try again in a moment.",
            });
          }
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
 * Run verified-email matching for a mirrored user, inside the trigger's own
 * transaction.
 *
 * Failure is reported but **not** rethrown, which is the opposite of the
 * mirroring above it. The distinction is what the failure costs: a user row
 * that does not exist means the account is invisible to every guard, so that
 * has to abort the sign-up. A missed invitation match only means the person
 * signs in as a guest — recoverable in one tap through `users.refreshRoles`,
 * and not worth failing an authentication over on party night.
 */
async function runEmailMatching(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<void> {
  try {
    const user = await ctx.db.get(userId);
    if (user) await applyVerifiedEmailMatching(ctx, user, { now });
  } catch (error) {
    captureError({ scope: "auth.trigger.emailMatching", error, level: "warning" });
  }
}

/**
 * Enforce the per-address send cooldown and hourly ceiling before an OTP email
 * goes out.
 *
 * Runs as a Convex mutation so the read-decide-write is transactional; two
 * simultaneous "email me a code" taps cannot both win. The 429 depends only on
 * the send history for the address — never on whether an account exists — so it
 * leaks nothing an attacker did not already know.
 *
 * Better Auth serves this endpoint from an HTTP action, so `ctx` has
 * `runMutation`. If some future call path hands us a query context there is no
 * way to write the counter; failing closed is the only safe answer, because the
 * alternative is an unthrottled mailbomb endpoint.
 */
async function assertOtpSendAllowed(ctx: GenericCtx<DataModel>, email: string): Promise<void> {
  if (!("runMutation" in ctx)) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "We could not send that code. Try again in a moment.",
    });
  }

  const decision = await ctx.runMutation(otpFunctions.registerSend, {
    email: normaliseEmail(email),
  });

  if (!decision.allowed) {
    const reason: OtpSendDenial = decision.reason ?? "rateLimited";
    throw new APIError("TOO_MANY_REQUESTS", {
      message: OTP_SEND_DENIAL_MESSAGES[reason],
      retryAfterMs: decision.retryAfterMs,
    });
  }
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
