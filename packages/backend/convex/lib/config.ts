import { constantTimeEqual } from "@partybooth/contracts";
import { envIsSet, envOptional, serverEnv } from "@partybooth/env/server";

/**
 * Deployment-level configuration, read lazily so that importing a module never
 * throws for a missing variable. Everything here has either a documented
 * fallback or a loud, specific error.
 */

/**
 * Where Better Auth serves from.
 *
 * Better Auth runs inside Convex HTTP actions, so this is the Convex **site**
 * URL (`https://<name>.convex.site`), not the Vercel site. `BETTER_AUTH_URL`
 * exists so the two can be set independently, but in practice it should equal
 * `CONVEX_SITE_URL` — if they disagree, OAuth callbacks land nowhere.
 */
export function authBaseUrl(): string {
  return envOptional(serverEnv, "BETTER_AUTH_URL") ?? serverEnv.CONVEX_SITE_URL;
}

/** The public web app: emails, QR universal links, OAuth redirect targets. */
export function siteUrl(): string {
  return serverEnv.SITE_URL;
}

/**
 * Origins allowed to drive the auth endpoints. The mobile app talks to Convex
 * directly and needs its custom scheme allowed for the OAuth return leg.
 */
export function trustedOrigins(): string[] {
  const origins = new Set<string>();
  const site = envOptional(serverEnv, "SITE_URL");
  if (site) origins.add(stripTrailingSlash(site));
  const authUrl = envOptional(serverEnv, "BETTER_AUTH_URL");
  if (authUrl) origins.add(stripTrailingSlash(authUrl));
  const convexSite = envOptional(serverEnv, "CONVEX_SITE_URL");
  if (convexSite) origins.add(stripTrailingSlash(convexSite));
  // `SITE_URL` may be the LAN address used by Expo while the browser uses the
  // fixed Next.js development origin. localhost is trusted only on a deployment
  // that has *said* it is a development deployment — see
  // `isExplicitDevelopmentDeployment`. Neither localhost nor a private-network
  // origin belongs in the production allowlist.
  if (isExplicitDevelopmentDeployment()) {
    origins.add("http://localhost:3000");
  }
  // Expo dev builds and the shipped app return through the custom scheme.
  origins.add("partybooth://");
  return [...origins];
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Is this deployment *explicitly* marked as development?
 *
 * `DEPLOYMENT_ENVIRONMENT` is declared with `.default("development")`
 * (packages/env/src/schema.ts). That default is right for the rails that
 * *tighten* on production — the console email sender refuses to fake a success
 * unless it is development (`lib/email/index.ts`) — and exactly wrong for
 * anything that *widens* trust, because it means a deployment nobody configured
 * looks like a development deployment. `envIsSet` asks the only safe question
 * here: did a human set the variable at all. A value the schema rejects is
 * reported once and treated as "not development" rather than throwing out of the
 * whole auth config.
 */
function isExplicitDevelopmentDeployment(): boolean {
  if (!envIsSet(serverEnv, "DEPLOYMENT_ENVIRONMENT")) return false;
  return (
    tolerant("DEPLOYMENT_ENVIRONMENT", () => serverEnv.DEPLOYMENT_ENVIRONMENT) === "development"
  );
}

/* -------------------------------------------------------------------------- */
/* Tolerating a bad value                                                     */
/* -------------------------------------------------------------------------- */

const warned = new Set<string>();

/**
 * Read an optional variable, treating an **invalid** value the same as a
 * missing one — loudly, but without throwing.
 *
 * `envOptional` returns `undefined` for an unset variable but still throws for
 * one that fails validation, which is right for a variable on the critical
 * path. It is wrong for these three: a typo in `ADMIN_EMAIL_ALLOWLIST` must not
 * take down guest sign-in on party night, a two-digit `DEMO_LOGIN_OTP` must not
 * do it either, and a mistyped `DEPLOYMENT_ENVIRONMENT` (`dev`, `Development`)
 * must not take down the whole auth config — `trustedOrigins` is built for every
 * auth request, so a throw there 500s every `/api/auth/*` call rather than just
 * the feature that read the variable. All three fail closed instead — no admins,
 * no demo bypass, not a development deployment — and say so in the logs.
 */
function tolerant<T>(key: string, read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch (error) {
    if (!warned.has(key)) {
      warned.add(key);
      console.error(
        `[config] ${key} is set but invalid, so it is being ignored. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return undefined;
  }
}

/** Test seam: lets a test assert the warning fires more than once. */
export function resetConfigWarnings(): void {
  warned.clear();
}

/* -------------------------------------------------------------------------- */
/* Global admin allowlist                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Emails permitted to sign in at `/admin`.
 *
 * Server-side only, and deliberately **not** a database flag: an attacker who
 * gets a write into `users` still cannot mint an admin. `users.isGlobalAdmin`
 * is a cache of this list, refreshed on sign-in; this function stays the
 * authority.
 *
 * An unset — or malformed — allowlist yields an empty list, so nobody is an
 * admin and a misconfigured deployment fails closed rather than open.
 */
export function adminEmailAllowlist(): readonly string[] {
  return (
    tolerant("ADMIN_EMAIL_ALLOWLIST", () => envOptional(serverEnv, "ADMIN_EMAIL_ALLOWLIST")) ?? []
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmailAllowlist().includes(email.trim().toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* App Review demo account                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fixed reviewer credentials App Review needs (PLAN.md: "a reviewer demo
 * account that bypasses live OTP").
 *
 * Returns `undefined` unless both variables are set, so the bypass simply does
 * not exist in a deployment that has not opted in. Never enable this in a
 * deployment real guests use.
 */
export function demoLogin(now: number = Date.now()): { email: string; code: string } | undefined {
  const email = tolerant("DEMO_LOGIN_EMAIL", () => envOptional(serverEnv, "DEMO_LOGIN_EMAIL"));
  const code = tolerant("DEMO_LOGIN_OTP", () => envOptional(serverEnv, "DEMO_LOGIN_OTP"));
  if (!email || !code) return undefined;

  /*
   * **Three** variables, and the third is a clock.
   *
   * The mitigation for a leaked fixed credential used to be entirely
   * operational — "unset both variables once the build is approved" — which is a
   * line in a runbook standing between a published password and a production
   * deployment. Review cycles run days and resubmissions run weeks, so the
   * window is real and nobody is watching it.
   *
   * `DEMO_LOGIN_EXPIRES_AT` is required rather than optional, and it fails
   * closed: an unparseable value, or one in the past, switches the bypass off
   * exactly as an unset `DEMO_LOGIN_OTP` does. Forgetting to remove it therefore
   * costs a resubmission rather than an open door.
   */
  const expiresAt = demoLoginExpiry();
  if (expiresAt === undefined || now >= expiresAt) return undefined;

  return { email: email.toLowerCase(), code };
}

/** `DEMO_LOGIN_EXPIRES_AT` as epoch milliseconds, or `undefined` if unusable. */
export function demoLoginExpiry(): number | undefined {
  const raw = tolerant("DEMO_LOGIN_EXPIRES_AT", () =>
    envOptional(serverEnv, "DEMO_LOGIN_EXPIRES_AT"),
  );
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    console.error("[config] DEMO_LOGIN_EXPIRES_AT is not a date, so the demo login is off.");
    return undefined;
  }
  return parsed;
}

/**
 * Whether `email` is the reviewer account and `code` is its fixed code.
 *
 * The code comparison is constant-time. The address is not, and does not need
 * to be — it is not a secret, and `DEMO_LOGIN_EMAIL` is a value the reviewer is
 * handed. The code is the credential.
 */
export function isDemoLogin(email: string, code: string): boolean {
  const demo = demoLogin();
  if (!demo) return false;
  if (!isDemoAddress(email)) return false;
  return constantTimeEqual(demo.code, code);
}

/**
 * Is this the reviewer's address, on a deployment that has opted in?
 *
 * The **whole** gate is "both variables are set". Sprint 3 left a note here
 * asking for `DEPLOYMENT_ENVIRONMENT !== "production"` on top, and that note was
 * wrong about the threat: App Review reviews the *production* build against the
 * *production* backend, so a production block would not harden the bypass, it
 * would delete the feature and guarantee a rejection. The environment marker
 * cannot distinguish "the party deployment" from "the deployment Apple is
 * looking at" because on 5 August they are the same deployment.
 *
 * So the controls are the ones that survive that:
 *
 * - **Three variables, all required.** A deployment that sets none — which is
 *   every deployment by default, and `.env.example` ships all three blank — has
 *   no bypass at all. There is no code path from an unset variable to a fixed
 *   code. This is what the tests pin.
 * - **It expires by itself.** `DEMO_LOGIN_EXPIRES_AT` is mandatory and fails
 *   closed, so the credential stops working on a date rather than when somebody
 *   remembers to unset it. See {@link demoLogin}.
 * - **Exactly one address.** Nothing about any other account changes: other
 *   addresses get a random code, a real email, and the full throttle.
 * - **Audited on every use** (`auth.demo_sign_in`). If that action appears in a
 *   deployment real guests are using, that is the incident, and it is greppable.
 * - **Confined to the demo party.** The credential used to unlock "a party with
 *   no real people in it" only because nothing had invited it anywhere else —
 *   which is not a control, it is an absence. Anyone holding the published
 *   credentials and a six-digit code could join and interact with a real party.
 *   `assertDemoConfinement` in `lib/guards.ts` now refuses the demo identity
 *   every event that is not `events.isDemo`, at join and on every event-scoped
 *   read and write.
 *
 * The residual risk is a leaked `DEMO_LOGIN_OTP` against a deployment inside its
 * expiry window, which now buys an attacker a fictional party. The runbook step
 * survives as hygiene rather than as the only line of defence: **unset all three
 * variables once the build is approved.**
 */
export function isDemoAddress(email: string | null | undefined): boolean {
  const demo = demoLogin();
  if (!demo || !email) return false;
  return demo.email === email.trim().toLowerCase();
}
