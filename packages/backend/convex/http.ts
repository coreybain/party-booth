import { httpRouter } from "convex/server";

import { authComponent, createAuth } from "./auth";

/**
 * HTTP surface of the deployment.
 *
 * Better Auth mounts at `/api/auth/*` on the Convex **site** URL
 * (`https://<name>.convex.site`). CORS is on because two different origins talk
 * to it: the Vercel web app and the Expo app.
 */
const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
