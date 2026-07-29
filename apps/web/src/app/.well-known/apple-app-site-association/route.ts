import { envOptional, serverEnv } from "@partybooth/env/server";

import { associationResponse, buildAppleAppSiteAssociation } from "@/lib/app-links";

/**
 * `GET /.well-known/apple-app-site-association`
 *
 * iOS fetches this once at install time and will not open `https://<host>/join/…`
 * in the app without it, however many `associatedDomains` entries the app
 * declares. Served from a Route Handler rather than `public/` because the team
 * id is per-deployment configuration, and a placeholder committed to the repo is
 * exactly the file that gets shipped to production by accident.
 *
 * Must be `application/json` and must have **no** file extension, which is why
 * the directory is named after the whole file.
 *
 * Verify after every deploy:
 *   curl -sI https://<host>/.well-known/apple-app-site-association
 *   curl -s  https://<host>/.well-known/apple-app-site-association | jq .
 * Both are asserted by `bun run verify:app-links` (scripts/verify-app-links.mjs).
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return associationResponse(
    buildAppleAppSiteAssociation({
      teamId: envOptional(serverEnv, "APPLE_TEAM_ID"),
      bundleId: envOptional(serverEnv, "APPLE_APP_BUNDLE_IDENTIFIER"),
    }),
  );
}
