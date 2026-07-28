import type { SignedReadUrl, StorageObjectRef, StorageRegion } from "@partybooth/contracts/storage";

/**
 * The storage seam.
 *
 * ADR 0002 makes one promise about multi-region: *a storage adapter is the only
 * code that knows a region is real.* This interface is that adapter. Given an
 * `events.storageRegion` value it resolves the provider app behind it, and every
 * read and delete in the product goes through it — "the moment one route handler
 * reaches for an UploadThing token directly, the seam is decorative".
 *
 * It is deliberately **small**. Two provider operations exist today because two
 * are all the request path needs:
 *
 * - {@link StorageAdapter.createReadUrl} — mint a short-lived URL for an object
 *   whose ACL is private. Every read path in the product calls this, after a
 *   permission check, and no read path ever returns a file key.
 * - {@link StorageAdapter.deleteFiles} — make the bytes stop existing. This is
 *   what "withdrawal is permanent" means at the storage layer, and it is why
 *   deletion invalidates outstanding signed URLs regardless of their expiry.
 *
 * The other two halves of the pipeline are deliberately *not* here. Validating
 * and consuming a grant, and registering a completed upload, are database
 * operations against Convex — the provider has no opinion about either — so they
 * live in `lib/upload-grants.ts` and `lib/media.ts`. Putting them behind the
 * provider interface would mean a fake provider could change what a grant means,
 * which is the one thing tests must not be able to do.
 *
 * ## Why every method is async
 *
 * Because one implementation needs the network and the other does not, and call
 * sites must not care which. UploadThing's `generateSignedURL` signs locally
 * (documented: "does not make a fetch request to the UploadThing API") so it is
 * safe inside a Convex query; `deleteFiles` is a real HTTP call and therefore
 * only legal in an action — see `media.purgeStoredFile`.
 */
export interface StorageAdapter {
  readonly region: StorageRegion;
  /** `"uploadthing"`, `"fake"` or `"unconfigured"`. Audit metadata, not policy. */
  readonly provider: string;
  /** `false` when no credentials exist: read paths degrade instead of crashing. */
  readonly configured: boolean;

  /**
   * A URL that works for `expiresInSeconds` and then does not.
   *
   * Callers have already done the permission check. This does not — it cannot;
   * it has no idea who is asking. That split is on purpose: the permission rules
   * live in `@partybooth/contracts` where they are exhaustively tested, and the
   * adapter is only the thing that turns "yes" into bytes.
   */
  createReadUrl(key: string, options?: { expiresInSeconds?: number }): Promise<SignedReadUrl>;

  /**
   * Delete objects. Idempotent: deleting a key that is already gone is a
   * success, because withdrawal must not be able to fail permanently on a
   * retry.
   */
  deleteFiles(keys: readonly string[]): Promise<{ deleted: number }>;

  /** What this adapter resolved the region to. For audit rows and `/admin`. */
  describe(): StorageAppDescription;
}

export interface StorageAppDescription {
  region: StorageRegion;
  provider: string;
  configured: boolean;
  /** Never the token. Present only when the provider exposes a non-secret id. */
  appId?: string | undefined;
}

export type { SignedReadUrl, StorageObjectRef };

/**
 * Raised when a read or delete is attempted on a deployment with no storage
 * credentials. Read paths catch it and omit the URL — a gallery that renders
 * without thumbnails is a better party than a gallery that throws — while
 * deletes let it escape, because silently not deleting a withdrawn photo is the
 * worst outcome in the product.
 */
export class StorageNotConfiguredError extends Error {
  override readonly name = "StorageNotConfiguredError";
  constructor(region: StorageRegion) {
    super(
      `No storage credentials for region "${region}". Set UPLOADTHING_TOKEN on this deployment — run \`pnpm env:doctor\` for the list.`,
    );
  }
}
