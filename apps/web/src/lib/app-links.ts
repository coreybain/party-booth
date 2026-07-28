/**
 * The two documents that make a scanned QR open the app instead of a browser tab.
 *
 * `apps/mobile/app.config.ts` declares `applinks:<host>` for iOS and an
 * `autoVerify` intent filter on `https://<host>/join` for Android. Both are
 * *claims*, and both platforms refuse to honour a claim unless the site itself
 * corroborates it:
 *
 *   - iOS fetches `https://<host>/.well-known/apple-app-site-association` at
 *     install time (through Apple's CDN) and matches `TEAMID.bundleid`.
 *   - Android fetches `https://<host>/.well-known/assetlinks.json` at install
 *     time and matches the package name against the SHA-256 fingerprint of the
 *     certificate the installed APK was actually signed with.
 *
 * Declaring the association on one side only is the failure mode this module
 * exists to close: the app looks correctly configured, `expo prebuild` is happy,
 * and the printed QR silently opens Safari at the party.
 *
 * Both builders return `null` when the deployment does not have the values, and
 * the routes then answer 404. That is deliberate and it is the safer default: a
 * *wrong* association document is worse than a missing one, because both
 * platforms cache what they fetched, and a guest who installed the app against a
 * bad file keeps a broken link until they reinstall.
 *
 * Pure functions, no `next/*` imports — the routes are three lines each and the
 * shape is unit-tested here rather than in a deployment.
 */

/** The path the QR encodes, and the only path either app claims. */
export const JOIN_PATH_PATTERN = "/join/*";

export interface AppleAppSiteAssociation {
  readonly applinks: {
    readonly details: readonly {
      readonly appIDs: readonly string[];
      readonly components: readonly Record<string, unknown>[];
    }[];
  };
}

export interface AssetLinkStatement {
  readonly relation: readonly string[];
  readonly target: {
    readonly namespace: "android_app";
    readonly package_name: string;
    readonly sha256_cert_fingerprints: readonly string[];
  };
}

/**
 * Apple's association document.
 *
 * The modern `components` form rather than the legacy `paths` array: Apple has
 * accepted it since iOS 13 and it is the one that can express the query-string
 * door (`/join?code=…`) as well as the path one. Nothing outside `/join` is
 * claimed — the organiser console and `/admin` must keep opening in a browser,
 * and a greedy `*` here would hijack them on any phone with the app installed.
 */
export function buildAppleAppSiteAssociation(params: {
  teamId: string | undefined;
  bundleId: string | undefined;
}): AppleAppSiteAssociation | null {
  const teamId = params.teamId?.trim();
  const bundleId = params.bundleId?.trim();
  if (!teamId || !bundleId) return null;

  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: [
            { "/": JOIN_PATH_PATTERN, comment: "QR / universal-link invite tokens" },
            {
              "/": "/join",
              "?": { code: "?*" },
              comment: "A six-digit code shared as a plain link",
            },
          ],
        },
      ],
    },
  };
}

/** Google's Digital Asset Links statement list. */
export function buildAssetLinks(params: {
  packageName: string | undefined;
  fingerprints: readonly string[] | undefined;
}): readonly AssetLinkStatement[] | null {
  const packageName = params.packageName?.trim();
  const fingerprints = (params.fingerprints ?? []).map((value) => value.trim()).filter(Boolean);
  if (!packageName || fingerprints.length === 0) return null;

  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

/**
 * One response shape for both documents.
 *
 * `application/json` is required for the Apple file even though it has no
 * extension, and `no-store` keeps a preview deployment's answer from being
 * cached against the production domain by anything in between.
 */
export function associationResponse(body: unknown | null): Response {
  if (body === null) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
