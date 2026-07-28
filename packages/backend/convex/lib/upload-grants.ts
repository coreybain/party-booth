import { generateSecret, type RandomBytes } from "@partybooth/contracts/codes";
import type { MediaType } from "@partybooth/contracts/media";
import type { StorageRegion } from "@partybooth/contracts/storage";
import { grantExpiresAt, isGrantUsable, type GrantUsability } from "@partybooth/contracts/upload";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";
import { sha256Hex } from "./hash";

/**
 * Minting, finding and spending upload grants.
 *
 * The policy — TTL, what "usable" means, what a completion has to match — is
 * pure and lives in `@partybooth/contracts/upload`. This file is the database
 * half, and it holds exactly one interesting property:
 *
 * > **Consumption is atomic.** {@link consumeGrant} reads the row, decides, and
 * > writes the new status inside a single Convex mutation. Convex mutations are
 * > serialisable transactions with optimistic concurrency: if two callers race
 * > for the same grant, one commits and the other is re-executed against the
 * > committed state, where it finds `status: "consumed"` and is refused. There
 * > is no window in which both see `issued`.
 *
 * That is the whole of "single use", and it is why the check and the write must
 * never be split across two mutations or moved into an action.
 *
 * The secret itself is **never stored**. Only a SHA-256 of it, exactly as
 * `userEmails` stores OTP codes: a leak of `uploadGrants` must not be a leak of
 * usable capabilities. Nothing logs it, nothing audits it, and it is returned to
 * the client precisely once.
 */

/** 32 bytes of Crockford base32 — the same primitive the invite tokens use. */
const GRANT_SECRET_BYTES = 32;

export interface IssueGrantParams {
  eventId: Id<"events">;
  userId: Id<"users">;
  captureId: string;
  mediaType: MediaType;
  fromLibrary: boolean;
  storageRegion: StorageRegion;
  byteSize: number;
  mimeType: string;
  checksum: string;
  durationSeconds?: number | undefined;
  capturedAt?: number | undefined;
  sourceMetadataStripped?: boolean | undefined;
  now: number;
  /** Injectable randomness, for deterministic tests. */
  randomBytes?: RandomBytes | undefined;
}

export interface IssuedGrantRow {
  grantId: Id<"uploadGrants">;
  /** Plaintext. Returned once, to the caller that asked. Never persisted. */
  secret: string;
  expiresAt: number;
}

export async function issueGrant(
  ctx: MutationCtx,
  params: IssueGrantParams,
): Promise<IssuedGrantRow> {
  const secret = generateSecret(GRANT_SECRET_BYTES, params.randomBytes);
  const expiresAt = grantExpiresAt(params.now);

  const grantId = await ctx.db.insert("uploadGrants", {
    eventId: params.eventId,
    userId: params.userId,
    captureId: params.captureId,
    secretHash: await sha256Hex(secret),
    status: "issued",
    mediaType: params.mediaType,
    fromLibrary: params.fromLibrary,
    storageRegion: params.storageRegion,
    byteSize: params.byteSize,
    mimeType: params.mimeType,
    checksum: params.checksum,
    ...(params.durationSeconds === undefined ? {} : { durationSeconds: params.durationSeconds }),
    ...(params.capturedAt === undefined ? {} : { capturedAt: params.capturedAt }),
    ...(params.sourceMetadataStripped === undefined
      ? {}
      : { sourceMetadataStripped: params.sourceMetadataStripped }),
    issuedAt: params.now,
    expiresAt,
    createdAt: params.now,
    updatedAt: params.now,
  });

  return { grantId, secret, expiresAt };
}

/**
 * Find a grant by the secret its holder presents.
 *
 * By hash, through an index — the plaintext never touches a query. A caller with
 * a wrong secret gets `null`, which is indistinguishable from an expired or
 * already-swept one, and that is fine: unlike a six-digit code, a 32-byte secret
 * has nothing to enumerate.
 */
export async function findGrantBySecret(
  ctx: ReadCtx,
  secret: string,
): Promise<Doc<"uploadGrants"> | null> {
  const hash = await sha256Hex(secret);
  return await ctx.db
    .query("uploadGrants")
    .withIndex("by_secretHash", (q) => q.eq("secretHash", hash))
    .unique();
}

export type ConsumeResult =
  | { ok: true; grant: Doc<"uploadGrants"> }
  | { ok: false; reason: "unknownGrant" }
  | { ok: false; reason: "expired" | "alreadyConsumed"; grant: Doc<"uploadGrants"> };

/**
 * Spend a grant, exactly once.
 *
 * See the module comment for why the read and the write have to be in the same
 * mutation. `fileKey` is recorded on the row so that a **duplicate callback**
 * carrying the same key can be recognised as a repeat of the completion we
 * already handled, rather than as a second file smuggled in against one grant —
 * the caller uses `consumedFileKey` to tell those two apart.
 *
 * A grant that has run out of time is patched to `expired` on the way past. That
 * is tidying, not enforcement: `isGrantUsable` refuses on the clock whether or
 * not anything ever got round to writing the status.
 */
export async function consumeGrant(
  ctx: MutationCtx,
  secret: string,
  fileKey: string,
  now: number,
): Promise<ConsumeResult> {
  const grant = await findGrantBySecret(ctx, secret);
  if (!grant) return { ok: false, reason: "unknownGrant" };

  const usability: GrantUsability = isGrantUsable(grant, now);
  if (!usability.usable) {
    if (usability.reason === "expired" && grant.status === "issued") {
      await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    }
    return { ok: false, reason: usability.reason, grant };
  }

  await ctx.db.patch(grant._id, {
    status: "consumed",
    consumedAt: now,
    consumedFileKey: fileKey,
    updatedAt: now,
  });

  const consumed = await ctx.db.get(grant._id);
  // `get` after `patch` inside the same transaction sees the write.
  return { ok: true, grant: consumed ?? grant };
}

/** Attach the media row a grant produced, so the two can be walked either way. */
export async function linkGrantToMedia(
  ctx: MutationCtx,
  grantId: Id<"uploadGrants">,
  mediaId: Id<"media">,
  now: number,
): Promise<void> {
  await ctx.db.patch(grantId, { mediaId, updatedAt: now });
}

/**
 * Retire every unspent grant for a capture.
 *
 * Called when a capture is withdrawn. Without it, a guest who withdraws a photo
 * while its upload is still in flight would have the completion callback arrive
 * against a live grant a moment later — and "withdrawal is permanent" would
 * depend on the network being slower than the user. Expiring the grant closes
 * that door from our side; `registerCompletion` closes it from the other by
 * discarding a file whose media row is already `deleted`.
 */
export async function expireGrantsForCapture(
  ctx: MutationCtx,
  eventId: Id<"events">,
  captureId: string,
  now: number,
): Promise<number> {
  const grants = await ctx.db
    .query("uploadGrants")
    .withIndex("by_event_and_capture", (q) => q.eq("eventId", eventId).eq("captureId", captureId))
    .collect();

  let expired = 0;
  for (const grant of grants) {
    if (grant.status !== "issued") continue;
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    expired += 1;
  }
  return expired;
}
