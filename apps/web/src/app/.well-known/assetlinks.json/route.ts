import { envOptional, serverEnv } from "@partybooth/env/server";

import { associationResponse, buildAssetLinks } from "@/lib/app-links";

/**
 * `GET /.well-known/assetlinks.json`
 *
 * Android verifies this at install time and silently downgrades the app's
 * `autoVerify` intent filter to "ask the user" — or to nothing at all — if the
 * fingerprint does not match the certificate the installed build was signed
 * with. Play App Signing re-signs uploads, so the fingerprint that matters in
 * production is the *app signing* key from the Play Console, not the upload key;
 * `ANDROID_CERT_FINGERPRINTS` takes a list so both can be served while internal
 * testing builds are going out.
 *
 * A Route Handler rather than a static file for the same reason as the Apple
 * one: these are per-deployment secrets-adjacent values, not constants.
 *
 * Verify after every deploy (and after any signing-key change):
 *   curl -s https://<host>/.well-known/assetlinks.json | jq .
 *   https://developers.google.com/digital-asset-links/tools/generator
 * `bun run verify:app-links` checks the served shape.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return associationResponse(
    buildAssetLinks({
      packageName: envOptional(serverEnv, "ANDROID_APP_PACKAGE"),
      fingerprints: envOptional(serverEnv, "ANDROID_CERT_FINGERPRINTS"),
    }),
  );
}
