import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Tells Convex to trust the JWTs Better Auth mints inside this deployment, so
 * `ctx.auth.getUserIdentity()` resolves in every query, mutation and action.
 *
 * The provider reads its JWKS from the Better Auth component's own table. A
 * static `JWKS` environment variable can be supplied later to skip that lookup
 * (`npx convex run auth:generateJwk | npx convex env set JWKS`); it is a
 * latency optimisation, not a requirement.
 */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
