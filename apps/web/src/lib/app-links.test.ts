import { describe, expect, it } from "vitest";

import { associationResponse, buildAppleAppSiteAssociation, buildAssetLinks } from "./app-links";

const TEAM_ID = "AB12CD34EF";
const BUNDLE_ID = "com.partybooth.app";
const FINGERPRINT =
  "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";

describe("apple-app-site-association", () => {
  it("names the app as TEAMID.bundleid", () => {
    const document = buildAppleAppSiteAssociation({ teamId: TEAM_ID, bundleId: BUNDLE_ID });
    expect(document?.applinks.details[0]?.appIDs).toEqual([`${TEAM_ID}.${BUNDLE_ID}`]);
  });

  it("claims the join paths and nothing else", () => {
    // A greedy claim would hijack the organiser console and /admin on every
    // phone with the app installed.
    const document = buildAppleAppSiteAssociation({ teamId: TEAM_ID, bundleId: BUNDLE_ID });
    const paths = (document?.applinks.details[0]?.components ?? []).map((c) => c["/"]);
    expect(paths).toContain("/join/*");
    expect(paths.every((path) => typeof path === "string" && path.startsWith("/join"))).toBe(true);
  });

  it("serves nothing at all rather than a document with a placeholder team", () => {
    // Both platforms cache what they fetch, so a wrong file outlives the deploy
    // that produced it. 404 is the recoverable state.
    expect(buildAppleAppSiteAssociation({ teamId: undefined, bundleId: BUNDLE_ID })).toBeNull();
    expect(buildAppleAppSiteAssociation({ teamId: TEAM_ID, bundleId: undefined })).toBeNull();
    expect(buildAppleAppSiteAssociation({ teamId: "  ", bundleId: BUNDLE_ID })).toBeNull();
  });
});

describe("assetlinks.json", () => {
  it("delegates URL handling to the signed package", () => {
    const statements = buildAssetLinks({
      packageName: BUNDLE_ID,
      fingerprints: [FINGERPRINT],
    });
    expect(statements).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: BUNDLE_ID,
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  it("carries several fingerprints — upload key and Play signing key", () => {
    const other = FINGERPRINT.replace(/^14/, "AA");
    const statements = buildAssetLinks({
      packageName: BUNDLE_ID,
      fingerprints: [FINGERPRINT, other],
    });
    expect(statements?.[0]?.target.sha256_cert_fingerprints).toEqual([FINGERPRINT, other]);
  });

  it("is null without a fingerprint — an unverifiable claim is worse than none", () => {
    expect(buildAssetLinks({ packageName: BUNDLE_ID, fingerprints: [] })).toBeNull();
    expect(buildAssetLinks({ packageName: BUNDLE_ID, fingerprints: undefined })).toBeNull();
    expect(buildAssetLinks({ packageName: undefined, fingerprints: [FINGERPRINT] })).toBeNull();
  });
});

describe("associationResponse", () => {
  it("serves application/json, which iOS requires for an extensionless file", async () => {
    const response = associationResponse({ applinks: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ applinks: {} });
  });

  it("404s when there is nothing to associate", () => {
    expect(associationResponse(null).status).toBe(404);
  });

  it("is never cached — a preview deploy must not answer for production", () => {
    expect(associationResponse({}).headers.get("cache-control")).toBe("no-store");
  });
});
