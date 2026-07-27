/**
 * Is there a Convex deployment to talk to?
 *
 * PartyBooth is being built before any provider credentials exist, so the whole
 * app has to render and be clickable with an empty `.env.local`. Every screen
 * that would otherwise call Convex checks {@link isBackendConfigured} first and
 * shows `<BackendNotConfigured />` instead of throwing.
 *
 * This module is safe to import from both server and client components: it only
 * ever touches `NEXT_PUBLIC_*` values.
 */

import { envOptional } from "@partybooth/env";
import { clientEnv } from "@partybooth/env/client";

/** Where Better Auth's routes are proxied from. Must match `app/api/auth/[...all]`. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The Convex deployment URL, or `undefined` when `NEXT_PUBLIC_CONVEX_URL` is
 * unset. Never throws — a missing value is a supported state before launch.
 */
export const convexUrl: string | undefined = envOptional(clientEnv, "NEXT_PUBLIC_CONVEX_URL");

/** True once a Convex deployment URL is configured. */
export const isBackendConfigured: boolean = convexUrl !== undefined;

/** The public origin, when configured. Used for canonical links and QR copy. */
export const siteUrl: string | undefined = envOptional(clientEnv, "NEXT_PUBLIC_SITE_URL");
