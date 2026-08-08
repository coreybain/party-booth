import type { StorageRegion } from "@partybooth/contracts/storage";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type GenericStoragePurgeSource =
  "avatarReplacement" | "avatarRemoval" | "accountAvatar" | "rejectedUpload";

/**
 * Persist the only trustworthy pointer to a non-media object before scheduling
 * its network delete. The caller schedules `media.purgeStoredFile` in the same
 * mutation, passing the returned id, so the intent and the scheduled work
 * commit atomically.
 */
export async function createStoragePurgeJob(
  ctx: MutationCtx,
  params: {
    region: StorageRegion;
    keys: readonly string[];
    source: GenericStoragePurgeSource;
    now: number;
  },
): Promise<Id<"storagePurgeJobs">> {
  const keys = [...new Set(params.keys)].filter((key) => key.length > 0);
  if (keys.length === 0) throw new Error("A storage purge job needs at least one key.");

  return await ctx.db.insert("storagePurgeJobs", {
    region: params.region,
    keys,
    source: params.source,
    state: "pending",
    attempts: 0,
    requested: keys.length,
    deleted: 0,
    createdAt: params.now,
    updatedAt: params.now,
  });
}
