import { z } from "zod";

/**
 * Storage regions PartyBooth can write media to.
 *
 * Per PLAN.md the beta is a single region (UploadThing `pdx1`, Portland). The
 * value is stored per **event** (`events.storageRegion`) from day one so that
 * multi-region (P5) is a data migration of nothing at all: upload grants carry
 * the region and the storage adapter resolves credentials/host from it.
 *
 * Files never migrate when the list grows — a region is immutable on an event
 * once the first upload lands.
 *
 * `@partybooth/env` declares the same list for `STORAGE_DEFAULT_REGION`;
 * `storage.test.ts` fails if the two ever drift.
 */
export const STORAGE_REGIONS = ["pdx1"] as const;

export type StorageRegion = (typeof STORAGE_REGIONS)[number];

export const storageRegionSchema = z.enum(STORAGE_REGIONS);

/** Human-readable labels, for admin/debug surfaces only (no picker UI at launch). */
export const STORAGE_REGION_LABELS: Record<StorageRegion, string> = {
  pdx1: "US West (Portland)",
};

export function isStorageRegion(value: unknown): value is StorageRegion {
  return typeof value === "string" && (STORAGE_REGIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Reading a private object                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every object PartyBooth stores has a **private** ACL, so there is no such
 * thing as "the URL of a photo" — only a signed URL that works for a while, for
 * whoever was permission-checked when it was minted.
 *
 * The TTL is a compromise with how Convex reactivity works, and it is worth
 * writing down rather than discovering. A Convex query re-runs when its *data*
 * changes, not when the clock moves, so a URL minted inside a gallery query is
 * as stale as the subscription is old. Too short and a slideshow left running
 * for ten minutes serves broken images; too long and a copied URL outlives the
 * moderation decision that should have killed it.
 *
 * Ten minutes is the settled answer, with `expiresAt` returned alongside every
 * URL so a client can refresh before it bites. Withdrawal does not wait for it:
 * the file is deleted from storage, which invalidates every outstanding URL for
 * it immediately, whatever their expiry says.
 */
export const SIGNED_READ_URL_TTL_SECONDS = 10 * 60;

/**
 * The shorter TTL for a one-off fetch that is not held in a subscription — an
 * export, a derivative job, a single "open original" tap.
 */
export const SIGNED_DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * The TTL for **host-only review surfaces**: the moderation queue, the reported
 * list, and the organiser home's recent submissions.
 *
 * A signed URL cannot be revoked. Removing a co-host, revoking a membership,
 * sweeping on rotation or locking the owner all cut every *new* read instantly —
 * `requireEventActor` sees no membership and throws — but a URL already minted
 * keeps resolving at the provider until it expires. The mitigation is therefore
 * the clock, applied where the exposure is worst.
 *
 * These three paths are the ones that hand out **`pending` originals**: items a
 * guest may never be shown at all, only ever visible because the viewer was a
 * host at the moment they polled. They are also continuously polled by an open
 * console, so a short expiry costs nothing — the next poll mints a fresh URL. A
 * removed co-host's residual window is a minute rather than ten.
 *
 * The approved gallery deliberately keeps {@link SIGNED_READ_URL_TTL_SECONDS}:
 * there the exposure is content the member was legitimately shown, and a
 * slideshow left running on a TV must not blink every sixty seconds.
 */
export const SIGNED_HOST_REVIEW_URL_TTL_SECONDS = 60;

export interface SignedReadUrl {
  url: string;
  /** Epoch milliseconds. Clients refresh rather than serve a dead image. */
  expiresAt: number;
}

/**
 * A stored object, as the server refers to it.
 *
 * `key` is the provider file key and is **server-only**: it names the object
 * directly, and handing one to a client would turn a permission-checked read
 * into a bearer token that never expires. Read paths return
 * {@link SignedReadUrl}s; nothing returns a key.
 */
export interface StorageObjectRef {
  key: string;
  region: StorageRegion;
}
