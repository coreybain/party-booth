import { serverFeatures } from "@partybooth/env/server";

import type { StorageAdapter, StorageAppDescription } from "./adapter";
import { StorageNotConfiguredError } from "./adapter";
import { createUploadThingAdapter } from "./uploadthing";

import type { StorageRegion } from "@partybooth/contracts/storage";

/**
 * One place decides which storage app a region means.
 *
 * ADR 0002: *"The adapter is only worth having if nothing bypasses it. The
 * moment one route handler reaches for an UploadThing token directly, the seam
 * is decorative."* So this function is the only caller of
 * {@link createUploadThingAdapter} in the deployment, and every read and delete
 * in `convex/` goes through what it returns.
 *
 * The region always comes from **the row**, never from the environment:
 * `media.storageRegion` for a read or a delete, `events.storageRegion` for a
 * grant. `STORAGE_DEFAULT_REGION` only ever seeds a new event. That is what
 * makes "files never migrate" true rather than aspirational — a future region
 * change cannot retroactively send a delete to the wrong app.
 */
export function resolveStorageAdapter(region: StorageRegion): StorageAdapter {
  const override = currentOverride();
  if (override !== undefined) return override(region);
  if (!serverFeatures.uploadthing) return unconfiguredAdapter(region);
  return createUploadThingAdapter(region);
}

/* -------------------------------------------------------------------------- */
/* No credentials                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a deployment with no `UPLOADTHING_TOKEN` gets.
 *
 * Every method throws {@link StorageNotConfiguredError}. Read paths catch it and
 * simply omit the URL — a gallery that lists a guest's own submissions with no
 * thumbnails still tells them their photo is pending, and that is the more
 * useful failure. Deletes deliberately let it escape: silently not deleting a
 * withdrawn photo is the worst outcome the product has.
 */
export function unconfiguredAdapter(region: StorageRegion): StorageAdapter {
  const description: StorageAppDescription = {
    region,
    provider: "unconfigured",
    configured: false,
  };
  // A *rejected promise*, not a synchronous throw. The interface is async, and
  // an implementation that throws before returning one is a different failure
  // mode from the one every caller is written against: `await` catches both,
  // `.catch()` catches only this.
  const fail = <T>(): Promise<T> => Promise.reject(new StorageNotConfiguredError(region));

  return {
    region,
    provider: "unconfigured",
    configured: false,
    createReadUrl: () => fail(),
    deleteFiles: () => fail(),
    describe: () => ({ ...description }),
  };
}

/* -------------------------------------------------------------------------- */
/* Test seam                                                                  */
/* -------------------------------------------------------------------------- */

type AdapterFactory = (region: StorageRegion) => StorageAdapter;

/**
 * Point every storage call at a different implementation, for the duration of a
 * test.
 *
 * A hook rather than an argument threaded through fifteen call sites, because
 * the alternative is either a `ctx` extension Convex does not have or a
 * parameter on every query that exists only for tests — and a production
 * signature shaped by its test harness is how the harness ends up being what
 * production actually runs.
 *
 * It hangs off `globalThis` rather than off a module-level `let`, and that is
 * not paranoia. `convex-test` loads queries and mutations through the
 * `import.meta.glob` map in `testing.helpers.ts` but evaluates **actions** in
 * their own module graph, so a module-level binding set by the suite is simply
 * not the binding a scheduled `purgeStoredFile` reads — the delete then runs
 * against the unconfigured adapter and every "the bytes are gone" assertion
 * fails for a reason that has nothing to do with the code under test. The realm
 * is the one thing both graphs share.
 *
 * Safe in the deployment for the same reason it is useful in a suite: nothing
 * outside `*.test.ts` and `testing.helpers.ts` calls it, and an isolate nobody
 * has told about an override cannot have one. Always restore it in `afterEach`.
 */
const OVERRIDE_KEY = "__partybooth_storage_adapter_override__";

interface OverrideHost {
  [OVERRIDE_KEY]?: AdapterFactory | undefined;
}

function overrideHost(): OverrideHost {
  return globalThis as unknown as OverrideHost;
}

function currentOverride(): AdapterFactory | undefined {
  return overrideHost()[OVERRIDE_KEY];
}

export function setStorageAdapterOverride(factory: AdapterFactory | undefined): void {
  overrideHost()[OVERRIDE_KEY] = factory;
}

export { StorageNotConfiguredError };
export type { StorageAdapter, StorageAppDescription };
