import { SIGNED_READ_URL_TTL_SECONDS, type StorageRegion } from "@partybooth/contracts/storage";

import type { SignedReadUrl, StorageAdapter, StorageAppDescription } from "./adapter";

/**
 * An in-memory storage provider, for `convex-test` and for any offline run.
 *
 * The whole point of the seam is that the pipeline can be exercised end to end
 * with no UploadThing account, no token and no network. So this keeps a `Map` of
 * keys it believes exist, mints URLs that are shaped like the real thing, and
 * lets a test assert the two facts that actually matter:
 *
 * - a withdrawn file was **really deleted** (`has(key) === false`), which is the
 *   storage half of "withdrawal is permanent";
 * - a read URL **expires**, and is bound to the key it was minted for.
 *
 * The signature is a plain counter-and-key digest rather than an HMAC. It is not
 * pretending to be secure — nothing verifies it — it exists so that two URLs for
 * two different keys are visibly different in an assertion.
 */
export interface FakeStorageAdapter extends StorageAdapter {
  /** Pretend the provider stored something, as a completion callback would. */
  put(key: string, byteSize?: number): void;
  has(key: string): boolean;
  /** Keys the adapter currently believes exist, in insertion order. */
  keys(): string[];
  /** Every delete asked for, including ones for keys that were already gone. */
  deleteCalls(): string[][];
  reset(): void;
}

export interface FakeStorageOptions {
  region?: StorageRegion | undefined;
  /** Frozen clock, so URL expiry is assertable without waiting. */
  now?: (() => number) | undefined;
  /** Make every read fail, to exercise the degrade-don't-crash read paths. */
  failReads?: boolean | undefined;
}

export function createFakeStorageAdapter(options: FakeStorageOptions = {}): FakeStorageAdapter {
  const region: StorageRegion = options.region ?? "pdx1";
  const now = options.now ?? (() => Date.now());
  const stored = new Map<string, number>();
  const deletes: string[][] = [];

  const description: StorageAppDescription = {
    region,
    provider: "fake",
    configured: true,
    appId: "fake-app",
  };

  return {
    region,
    provider: "fake",
    configured: true,

    put(key, byteSize = 0) {
      stored.set(key, byteSize);
    },
    has(key) {
      return stored.has(key);
    },
    keys() {
      return [...stored.keys()];
    },
    deleteCalls() {
      return deletes.map((batch) => [...batch]);
    },
    reset() {
      stored.clear();
      deletes.length = 0;
    },

    createReadUrl(key, urlOptions): Promise<SignedReadUrl> {
      if (options.failReads === true) {
        return Promise.reject(new Error("fake storage: reads are failing"));
      }
      const ttl = urlOptions?.expiresInSeconds ?? SIGNED_READ_URL_TTL_SECONDS;
      const expiresAt = now() + ttl * 1000;
      return Promise.resolve({
        url: `https://fake.ufs.test/${region}/${encodeURIComponent(key)}?expires=${expiresAt}&sig=${signature(key, expiresAt)}`,
        expiresAt,
      });
    },

    deleteFiles(keys) {
      deletes.push([...keys]);
      let deleted = 0;
      for (const key of keys) {
        if (stored.delete(key)) deleted += 1;
      }
      return Promise.resolve({ deleted });
    },

    describe() {
      return { ...description };
    },
  };
}

/** Not a security primitive. Just enough to make two URLs distinguishable. */
function signature(key: string, expiresAt: number): string {
  let hash = 0x811c9dc5;
  for (const char of `${key}:${expiresAt}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
