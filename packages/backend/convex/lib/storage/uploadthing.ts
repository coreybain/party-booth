import {
  SIGNED_READ_URL_TTL_SECONDS,
  type SignedReadUrl,
  type StorageRegion,
} from "@partybooth/contracts/storage";
import { envOptional, serverEnv } from "@partybooth/env/server";
import type { UTApi as UTApiClass } from "uploadthing/server";

import type { StorageAdapter, StorageAppDescription } from "./adapter";
import { StorageNotConfiguredError } from "./adapter";

/**
 * The real storage provider: UploadThing, private ACL, one app per region.
 *
 * Verified against https://docs.uploadthing.com and the installed
 * `uploadthing@7` type declarations on 28 Jul 2026 — the two calls used here
 * are:
 *
 * ```ts
 * new UTApi({ token, logLevel })
 * utapi.generateSignedURL(key, { expiresIn }): Promise<{ ufsUrl: string }>
 * utapi.deleteFiles(keys, opts?): Promise<{ success: boolean; deletedCount: number }>
 * ```
 *
 * `generateSignedURL` — **not** `getSignedURL` — on purpose. The docs are
 * explicit that it "does not make a fetch request to the UploadThing API", which
 * is what makes it legal inside a Convex *query*: a query may not touch the
 * network, and a gallery that has to round-trip a provider API per thumbnail is
 * a slideshow that stutters. `getSignedURL` is documented as deprecated in v8
 * for the same reason. `expiresIn` is capped by the provider at seven days; ours
 * is ten minutes (`SIGNED_READ_URL_TTL_SECONDS`).
 *
 * ## Why the SDK is imported dynamically
 *
 * Convex runs functions in a V8 isolate, not Node. `uploadthing/server` pulls in
 * `effect` and `@effect/platform`, and whether that whole tree evaluates cleanly
 * in the isolate is a thing that can only be established against a real
 * deployment — which, by design, nothing in this repo has (see CONTRIBUTING:
 * "everything typechecks and unit-tests fully offline"). Loading it lazily, from
 * inside the two methods that need it, buys three things:
 *
 * 1. The offline test run never evaluates it. `convex-test` maps every module in
 *    `convex/`, and a top-level import here would drag the SDK into every suite
 *    in the package.
 * 2. A deployment with no `UPLOADTHING_TOKEN` never evaluates it either — the
 *    resolver in `./index.ts` hands back the unconfigured adapter first.
 * 3. If the SDK turns out not to run in the isolate, the blast radius is this
 *    file. The fallback is a signing endpoint in `apps/web` behind the same
 *    {@link StorageAdapter} interface, and no call site changes.
 *
 * That third point is an **integrator verification item**, not a solved problem:
 * the first successful `convex dev` is what turns it from a plan into a fact.
 */

/**
 * The SDK's types come from a `import type` — erased at build time — so naming
 * them here costs nothing at runtime and still makes a signature change in
 * `uploadthing@7` a compile error rather than a party-night surprise.
 */
type UtApi = InstanceType<typeof UTApiClass>;

/**
 * One client per token, memoised for the life of the isolate.
 *
 * Convex recycles isolates freely, so this is a per-isolate cache and nothing
 * more — it must never hold anything that has to be consistent across requests.
 * A `UTApi` instance is inert configuration, which is why it is safe to keep.
 */
let cached: { token: string; client: Promise<UtApi> } | undefined;

async function utapi(token: string): Promise<UtApi> {
  if (cached?.token === token) return await cached.client;
  const client = import("uploadthing/server").then(
    ({ UTApi }) =>
      new UTApi({
        token,
        // The isolate's console is the deployment log. `error` keeps a party
        // night's worth of thumbnail requests from filling it.
        logLevel: "Error",
      }),
  );
  cached = { token, client };
  return await client;
}

/** Test seam: drop the memoised client so a suite cannot inherit another's. */
export function resetUploadThingClient(): void {
  cached = undefined;
}

/**
 * Resolve the provider app for a region.
 *
 * Today every region resolves to the same app, because the beta has one region
 * and UploadThing's dynamic region selection is in private beta (ADR 0002).
 * Multi-region (P5) changes this function and nothing else: either a token per
 * region read from the environment, or the dynamic-region option on the client.
 * The region is threaded through every call so that the day it matters, the call
 * sites already carry it.
 */
export function createUploadThingAdapter(region: StorageRegion): StorageAdapter {
  const token = envOptional(serverEnv, "UPLOADTHING_TOKEN");
  const appId = envOptional(serverEnv, "UPLOADTHING_APP_ID");
  const configured = token !== undefined && token !== "";
  const usesDevelopmentPublicFiles =
    serverEnv.UPLOADTHING_ACL === "public-read" &&
    serverEnv.DEPLOYMENT_ENVIRONMENT === "development" &&
    appId !== undefined;

  const description: StorageAppDescription = {
    region,
    provider: "uploadthing",
    configured,
    ...(appId === undefined ? {} : { appId }),
  };

  return {
    region,
    provider: "uploadthing",
    configured,

    async createReadUrl(key, options): Promise<SignedReadUrl> {
      if (!configured) throw new StorageNotConfiguredError(region);
      const expiresIn = options?.expiresInSeconds ?? SIGNED_READ_URL_TTL_SECONDS;

      /*
       * UploadThing's free plan stores public-read files. They do not need a
       * signature, and trying to load the private-file signing SDK from inside
       * a Convex V8 query can fail before a URL is returned. Keep this escape
       * hatch strictly development-only: production and every private ACL still
       * use short-lived signed URLs with the normal membership checks.
       */
      if (usesDevelopmentPublicFiles) {
        return {
          url: `https://${appId}.ufs.sh/f/${encodeURIComponent(key)}`,
          expiresAt: Date.now() + expiresIn * 1000,
        };
      }

      const client = await utapi(token);
      const { ufsUrl } = await client.generateSignedURL(key, { expiresIn });
      // The provider signs against its own clock; ours is close enough to tell a
      // client when to refresh, and a few seconds of skew only makes us early.
      return { url: ufsUrl, expiresAt: Date.now() + expiresIn * 1000 };
    },

    async deleteFiles(keys) {
      if (!configured) throw new StorageNotConfiguredError(region);
      if (keys.length === 0) return { success: true, deleted: 0 };
      const client = await utapi(token);
      const result = await client.deleteFiles([...keys]);
      return { success: result.success, deleted: result.deletedCount };
    },

    describe() {
      return { ...description };
    },
  };
}
