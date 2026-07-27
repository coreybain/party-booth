import { constantTimeEqual } from "@partybooth/contracts";
import { envOptional, serverEnv } from "@partybooth/env/server";

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
  // Expo dev builds and the shipped app return through the custom scheme.
  origins.add("partybooth://");
  return [...origins];
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
 * path. It is wrong for these two: a typo in `ADMIN_EMAIL_ALLOWLIST` must not
 * take down guest sign-in on party night, and a two-digit `DEMO_LOGIN_OTP` must
 * not do it either. Both fail closed instead — no admins, no demo bypass — and
 * say so in the logs.
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
export function demoLogin(): { email: string; code: string } | undefined {
  const email = tolerant("DEMO_LOGIN_EMAIL", () => envOptional(serverEnv, "DEMO_LOGIN_EMAIL"));
  const code = tolerant("DEMO_LOGIN_OTP", () => envOptional(serverEnv, "DEMO_LOGIN_OTP"));
  if (!email || !code) return undefined;
  return { email: email.toLowerCase(), code };
}

/**
 * Whether `email` is the reviewer account and `code` is its fixed code.
 *
 * The code comparison is constant-time. The address is not, and does not need
 * to be — it is not a secret, and `DEMO_LOGIN_EMAIL` is a value the reviewer is
 * handed. The code is the credential.
 *
 * TODO(Sprint 4): this is still unreferenced. When it *is* wired up, the bypass
 * must be gated on an explicit build/deployment marker
 * (`DEPLOYMENT_ENVIRONMENT !== "production"` at minimum) rather than on the
 * operator remembering not to set these two variables in the party deployment,
 * scoped to this one address and nothing else, given its own seeded demo event
 * with no real media, and audited on every sign-in.
 */
export function isDemoLogin(email: string, code: string): boolean {
  const demo = demoLogin();
  if (!demo) return false;
  if (demo.email !== email.trim().toLowerCase()) return false;
  return constantTimeEqual(demo.code, code);
}
