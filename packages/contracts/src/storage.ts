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
