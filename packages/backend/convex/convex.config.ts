import betterAuth from "@convex-dev/better-auth/convex.config";
import { defineApp } from "convex/server";

/**
 * Convex components used by PartyBooth.
 *
 * The Better Auth component owns its own tables (user, session, account,
 * verification, jwks) inside the component's namespace. Our application tables
 * live in `schema.ts` and reference Better Auth users by `authId`; the bridge
 * between the two is the `user` trigger in `auth.ts`.
 */
const app = defineApp();

app.use(betterAuth);

export default app;
