import "server-only";

import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
import { api } from "@partybooth/backend/api";
import { envOptional, serverEnv } from "@partybooth/env/server";
import type { FunctionReference } from "convex/server";

import { AUTH_BASE_PATH } from "./backend";

/**
 * Server-side half of the Better Auth ↔ Convex integration.
 *
 * `convexBetterAuthNextJs` gives us:
 *  - `handler`   — the `/api/auth/[...all]` proxy to Convex HTTP actions,
 *  - `isAuthenticated` / `getToken` — session checks in Server Components,
 *  - `fetchAuthQuery` / `preloadAuthQuery` — authenticated Convex reads.
 *
 * It is only constructed when both Convex URLs are present. Without them the
 * exports below degrade to "signed out, backend unavailable" rather than
 * throwing, which is what lets the whole app render on a machine with no
 * `.env.local` (see `backend.ts`).
 */

const convexUrl = envOptional(serverEnv, "CONVEX_URL");
const convexSiteUrl = envOptional(serverEnv, "CONVEX_SITE_URL");

/**
 * True when the server can reach Convex. Note this is the *server* view:
 * `isBackendConfigured` in `backend.ts` is the browser's view and keys off
 * `NEXT_PUBLIC_CONVEX_URL`. Both must be set for a working deployment;
 * `pnpm env:doctor` reports either being missing.
 */
export const isServerBackendConfigured: boolean =
  convexUrl !== undefined && convexSiteUrl !== undefined;

const convexAuth =
  convexUrl !== undefined && convexSiteUrl !== undefined
    ? convexBetterAuthNextJs({ convexUrl, convexSiteUrl, basePath: AUTH_BASE_PATH })
    : undefined;

/** 503 fallback used by `/api/auth/*` when Convex is not configured. */
function unavailable(): Response {
  return Response.json(
    {
      error: "backend_not_configured",
      message:
        "CONVEX_URL and CONVEX_SITE_URL are not set, so authentication is unavailable. " +
        "Run `pnpm env:doctor` for what to fill in.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** Route handler for `app/api/auth/[...all]/route.ts`. */
export const authRouteHandler = {
  GET: convexAuth ? convexAuth.handler.GET : (): Response => unavailable(),
  POST: convexAuth ? convexAuth.handler.POST : (): Response => unavailable(),
} as const;

/**
 * Is the current request signed in? Always `false` when Convex is not
 * configured — fail closed, never fail open.
 */
export async function isAuthenticated(): Promise<boolean> {
  if (!convexAuth) return false;
  try {
    return await convexAuth.isAuthenticated();
  } catch {
    // A cold or unreachable deployment must not 500 the page; treat it as
    // signed out and let the UI offer sign-in again.
    return false;
  }
}

/** The raw Convex identity token for the current request, if any. */
export async function getAuthToken(): Promise<string | undefined> {
  if (!convexAuth) return undefined;
  try {
    return await convexAuth.getToken();
  } catch {
    return undefined;
  }
}

/**
 * Authenticated Convex helpers. `undefined` until a backend exists, so call
 * sites must null-check — which is also the reminder to render the
 * "backend not configured" state.
 *
 * TODO(Sprint 2): these take function references out of
 * `@partybooth/backend` (`api.events.list`, …). Nothing else needs to change.
 */
export const fetchAuthQuery = convexAuth?.fetchAuthQuery;
export const fetchAuthMutation = convexAuth?.fetchAuthMutation;
export const preloadAuthQuery = convexAuth?.preloadAuthQuery;

/* -------------------------------------------------------------------------- */
/* Authorisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in account as PartyBooth sees it, not as Better Auth sees it.
 *
 * `isAuthenticated()` answers "is there a valid session", which is a question
 * about *authentication*. Every gate in this app is about *authorisation* —
 * organiser invitations and the `/admin` allowlist — and neither is a property
 * of the session. This is the shape those gates need.
 *
 * `isGlobalAdmin` is recomputed by `api.users.currentUser` from
 * `ADMIN_EMAIL_ALLOWLIST` on the server rather than read out of the cached
 * `users.isGlobalAdmin` column, so a tampered row cannot mint an admin.
 */
export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly accountState: string;
  readonly isOrganiser: boolean;
  readonly isGlobalAdmin: boolean;
}

/**
 * `api.users.currentUser`, typed.
 *
 * Until `npx convex dev` runs against a real deployment, `_generated/api.d.ts`
 * is the generic fallback (`AnyApi`), whose index access is `| undefined`.
 * That is the same cast `packages/backend/convex/auth.ts` documents, for the
 * same reason, and it becomes a no-op once precise codegen lands.
 */
const userFunctions = api.users as unknown as {
  currentUser: FunctionReference<"query", "public", Record<string, never>, AppUser | null>;
};

/**
 * The mirrored application user for this request, or `null`.
 *
 * Never throws: a cold deployment, an expired session or an unconfigured
 * backend all read as "signed out", which is the fail-closed answer for every
 * caller below.
 */
export async function getAppUser(): Promise<AppUser | null> {
  if (!fetchAuthQuery) return null;
  try {
    return (await fetchAuthQuery(userFunctions.currentUser, {})) ?? null;
  } catch {
    return null;
  }
}

/**
 * May this request use the organiser console?
 *
 * Private beta is invitation-only (PLAN.md), so a valid session is not enough:
 * the account must have accepted an organiser invitation (`isOrganiser`, which
 * only the Sprint 5 invitation flow may set) or be a global admin. Locked and
 * deletion-scheduled accounts are refused here as well as in Convex.
 */
export async function isOrganiserAuthorised(): Promise<boolean> {
  const user = await getAppUser();
  if (!user || user.accountState !== "active") return false;
  return user.isOrganiser || user.isGlobalAdmin;
}

/**
 * May this request use `/admin`?
 *
 * The authority is `ADMIN_EMAIL_ALLOWLIST`, evaluated server-side in Convex.
 * This is **defence in depth, not the boundary** — every admin query and
 * mutation added from Sprint 5 must call `requireGlobalAdmin` itself, because a
 * layout check protects the page and nothing else.
 */
export async function isGlobalAdminAuthorised(): Promise<boolean> {
  const user = await getAppUser();
  if (!user || user.accountState !== "active") return false;
  return user.isGlobalAdmin;
}
