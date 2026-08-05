import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { OTP_SEND_DENIAL_MESSAGES, type OtpSendDenial } from "@partybooth/contracts";
import { serverEnv } from "@partybooth/env/server";
import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import type { FunctionReference } from "convex/server";

import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import authConfig from "./auth.config";
import { scheduleAccountDeletion } from "./lib/account_deletion";
import { applyVerifiedEmailMatching } from "./lib/email_matching";
import {
  authBaseUrl,
  isAdminEmail,
  isDemoAddress,
  trustedOrigins,
  useSecureAuthCookies,
} from "./lib/config";
import { otpEmail, sendEmail } from "./lib/email";
import { emailOtpPolicyOptions, otpPurposeFor } from "./lib/otp";
import { resolveDisplayName } from "./lib/profile";
import { socialProviderConfig } from "./lib/providers";
import { isPrivateRelayEmail, mirrorAuthUser, normaliseEmail } from "./lib/user_mirror";
import { captureError } from "./lib/sentry";

/* -------------------------------------------------------------------------- */
/* Component client + app-side user mirror                                    */
/* -------------------------------------------------------------------------- */

/**
 * Until `bunx convex dev` runs against a real deployment, `convex codegen`
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
  recordDemoSignIn: FunctionReference<"mutation", "internal", { email: string }, null>;
};

const organiserInvitationFunctions = internal.organiser_invitations as unknown as {
  pendingTokenByEmail: FunctionReference<
    "query",
    "internal",
    { email: string },
    { token: string } | null
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
          const userId = await mirrorAuthUser(ctx, {
            authId: doc._id,
            email,
            emailVerified: doc.emailVerified ?? false,
            providerName: doc.name,
            now,
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

    advanced: {
      // Dynamic base URL resolution may trust forwarded headers only because
      // `authBaseUrl().allowedHosts` rejects every host PartyBooth did not name.
      // The Next.js proxy preserves the browser's original host in dedicated
      // headers; direct Expo requests keep resolving to the Convex site.
      trustedProxyHeaders: true,

      // Permit non-secure cookies only on an explicitly marked development
      // deployment; every other state fails secure.
      useSecureCookies: useSecureAuthCookies(),
    },

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
      magicLink({
        expiresIn: 10 * 60,
        storeToken: "hashed",
        generateToken: async (email) => {
          if (!("runQuery" in ctx)) {
            throw new APIError("FORBIDDEN", { message: "That invitation is not available." });
          }
          const invitation = await ctx.runQuery(organiserInvitationFunctions.pendingTokenByEmail, {
            email: normaliseEmail(email),
          });
          if (!invitation) {
            throw new APIError("FORBIDDEN", { message: "That invitation is not available." });
          }
          return invitation.token;
        },
        // Organiser links are delivered by `admin.inviteOrganiser`. This hook is
        // used only to stage the standard Better Auth magic-link verification
        // record after the recipient opens that already-delivered link.
        sendMagicLink: ({ metadata }) => {
          if (metadata?.["partyboothOrganiserInvite"] === true) return;
          throw new APIError("FORBIDDEN", { message: "That invitation is not available." });
        },
      }),
      emailOTP({
        // Six digits, ten-minute expiry, five attempts, sixty-second resend
        // cooldown — see `lib/otp.ts`, which derives all of it from
        // `@partybooth/contracts`.
        ...emailOtpPolicyOptions(),
        sendVerificationOTP: async ({ email, otp, type }) => {
          /*
           * The reviewer's address, on a deployment that opted in.
           *
           * There is no mailbox behind it — App Review is handed the code on the
           * submission form — so sending would fail and, because `sendEmail`
           * refusing is how "we couldn't email you" surfaces, would turn the
           * demo account into a 500 at the door. It also skips the per-address
           * send throttle, which exists to stop a mailbomb against a real
           * inbox: there is no inbox, and a reviewer who taps "resend" twice
           * and is told to wait sixty seconds files a rejection.
           *
           * Every other address is untouched — same throttle, same random code,
           * same email. That is the property worth protecting, and the tests
           * assert it directly.
           */
          if (isDemoAddress(email)) {
            await recordDemoSignIn(ctx, email);
            return;
          }

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
 * Leave a row saying the demo credential was used.
 *
 * Best-effort on purpose: a failure to write the audit row must not stop App
 * Review signing in, because a reviewer who cannot get past the first screen
 * rejects the build and the audit row is worth less than the submission. It is
 * reported rather than swallowed, so a deployment where this is silently failing
 * is visible in Sentry rather than only in its absence from the log.
 */
async function recordDemoSignIn(ctx: GenericCtx<DataModel>, email: string): Promise<void> {
  try {
    if (!("runMutation" in ctx)) return;
    await ctx.runMutation(otpFunctions.recordDemoSignIn, { email: normaliseEmail(email) });
  } catch (error) {
    captureError({ scope: "auth.demoSignIn", error, level: "warning" });
  }
}
