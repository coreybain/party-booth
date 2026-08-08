import { generateSecret, type RandomBytes } from "@partybooth/contracts/codes";
import type { MediaFileRole, MediaType } from "@partybooth/contracts/media";
import type { StorageRegion } from "@partybooth/contracts/storage";
import { grantExpiresAt } from "@partybooth/contracts/upload";

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
  /** Which artefact of the capture. `original` when omitted. */
  fileRole?: MediaFileRole | undefined;
  fromLibrary: boolean;
  storageRegion: StorageRegion;
  byteSize: number;
  mimeType: string;
  checksum: string;
  durationSeconds?: number | undefined;
  capturedAt?: number | undefined;
  sourceMetadataStripped?: boolean | undefined;
  sourceCarriesNoLocation?: boolean | undefined;
  challengeId?: Id<"photoChallenges"> | undefined;
  challengePrompt?: string | undefined;
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
    // Omitted rather than defaulted, so an `original` row reads exactly as it
    // did before Sprint 4 and `fileRoleOf` stays the one place that decides what
    // an absent value means.
    ...(params.fileRole === undefined || params.fileRole === "original"
      ? {}
      : { fileRole: params.fileRole }),
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
    // Same rule as `fileRole` above: omitted rather than defaulted, so a row
    // that says nothing keeps meaning what `metadataClaimOf` says it means
    // (inherit the re-encode claim) rather than being pinned to a value nobody
    // chose.
    ...(params.sourceCarriesNoLocation === undefined
      ? {}
      : { sourceCarriesNoLocation: params.sourceCarriesNoLocation }),
    ...(params.challengeId === undefined ? {} : { challengeId: params.challengeId }),
    ...(params.challengePrompt === undefined ? {} : { challengePrompt: params.challengePrompt }),
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

export type StartGrantResult =
  | { ok: true; grant: Doc<"uploadGrants"> }
  | { ok: false; reason: "unknownGrant" }
  | {
      ok: false;
      reason: "expired" | "alreadyStarted" | "alreadyConsumed";
      grant: Doc<"uploadGrants">;
    };

/**
 * Reserve a grant at authenticated edge preflight, exactly once.
 *
 * The TTL is checked here, before a provider URL exists. Completion consumes a
 * `started` row without consulting the clock, so a transfer which began on time
 * is not discarded merely because the bytes took longer than two minutes. The
 * expected owner is part of this transaction: a valid secret copied from
 * another account is indistinguishable from an unknown one.
 */
export async function startGrant(
  ctx: MutationCtx,
  secret: string,
  expectedUserId: Id<"users">,
  now: number,
): Promise<StartGrantResult> {
  const grant = await findGrantBySecret(ctx, secret);
  if (!grant || grant.userId !== expectedUserId) return { ok: false, reason: "unknownGrant" };

  if (grant.status === "consumed") {
    return { ok: false, reason: "alreadyConsumed", grant };
  }
  if (grant.status === "started") {
    return { ok: false, reason: "alreadyStarted", grant };
  }
  if (grant.status === "expired" || now > grant.expiresAt) {
    if (grant.status === "issued") {
      await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    }
    return { ok: false, reason: "expired", grant };
  }

  await ctx.db.patch(grant._id, { status: "started", startedAt: now, updatedAt: now });
  const started = await ctx.db.get(grant._id);
  return { ok: true, grant: started ?? grant };
}

export type ConsumeResult =
  | { ok: true; grant: Doc<"uploadGrants"> }
  | { ok: false; reason: "unknownGrant" }
  | {
      ok: false;
      reason: "expired" | "notStarted" | "alreadyConsumed";
      grant: Doc<"uploadGrants">;
    };

/**
 * Spend a grant, exactly once.
 *
 * See the module comment for why the read and the write have to be in the same
 * mutation. `fileKey` is recorded on the row so that a **duplicate callback**
 * carrying the same key can be recognised as a repeat of the completion we
 * already handled, rather than as a second file smuggled in against one grant —
 * the caller uses `consumedFileKey` to tell those two apart.
 *
 * Only a `started` grant may complete. The start transition already applied the
 * TTL under an authenticated identity; completion deliberately ignores the
 * clock so an on-time transfer can finish late. An `issued` callback is refused
 * because it bypassed that preflight.
 */
export async function consumeGrant(
  ctx: MutationCtx,
  secret: string,
  fileKey: string,
  now: number,
): Promise<ConsumeResult> {
  const grant = await findGrantBySecret(ctx, secret);
  if (!grant) return { ok: false, reason: "unknownGrant" };

  if (grant.status !== "started") {
    if (grant.status === "consumed") {
      return { ok: false, reason: "alreadyConsumed", grant };
    }
    if (grant.status === "issued" && now > grant.expiresAt) {
      await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
      return { ok: false, reason: "expired", grant };
    }
    if (grant.status === "expired") return { ok: false, reason: "expired", grant };
    return { ok: false, reason: "notStarted", grant };
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
    if (grant.status !== "issued" && grant.status !== "started") continue;
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    expired += 1;
  }
  return expired;
}

/**
 * Retire every unspent grant one account holds for one event.
 *
 * Called when a membership goes away — an invite rotation that does not keep
 * memberships, an admin revoking a seat, a host removing a co-host. Same
 * argument as {@link expireGrantsForCapture}, one level up: the completion path
 * validates the grant rather than the membership, so a removal that leaves live
 * grants behind is a removal somebody can upload through.
 *
 * Scoped to the event on purpose. Being thrown out of one party says nothing
 * about the photograph you are halfway through sending to another.
 */
export async function expireGrantsForUser(
  ctx: MutationCtx,
  eventId: Id<"events">,
  userId: Id<"users">,
  now: number,
): Promise<number> {
  const [issued, started] = await Promise.all([
    ctx.db
      .query("uploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "issued"))
      .collect(),
    ctx.db
      .query("uploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "started"))
      .collect(),
  ]);
  const grants = [...issued, ...started];

  let expired = 0;
  for (const grant of grants) {
    if (grant.eventId !== eventId) continue;
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    expired += 1;
  }
  return expired;
}

/**
 * Retire every unspent grant **anybody** holds for one event.
 *
 * The freeze instrument, next to {@link expireGrantsForUser}'s removal
 * instrument. Locking a host suspends the whole party, and a sweep that only
 * expired the *locked person's own* grants left every guest's live grant intact
 * — so for the two minutes of `GRANT_POLICY.ttlMs` a guest could still land a
 * file in a party the console says is frozen, move its counters, and ping the
 * hosts of an event that is supposed to be stopped. The console's own copy
 * promises "guests stop uploading", so this is the write that makes the sentence
 * true.
 *
 * There is no `by_event_and_status` index, and adding one to serve a rare admin
 * action would cost every upload a second index write; `by_event_and_capture`
 * covers the same rows for a scan that runs once per lock.
 */
export async function expireGrantsForEvent(
  ctx: MutationCtx,
  eventId: Id<"events">,
  now: number,
): Promise<number> {
  const grants = await ctx.db
    .query("uploadGrants")
    .withIndex("by_event_and_capture", (q) => q.eq("eventId", eventId))
    .collect();

  let expired = 0;
  for (const grant of grants) {
    if (grant.status !== "issued" && grant.status !== "started") continue;
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
    expired += 1;
  }
  return expired;
}

/**
 * Retire every unspent grant one account holds, in **every** event.
 *
 * Used when the account itself stops being allowed to do things — a lock, or a
 * scheduled deletion. Unlike {@link expireGrantsForUser} this is deliberately
 * not event-scoped: the premise there is "you were thrown out of one party",
 * and the premise here is "this account may not upload anywhere", which
 * includes the parties they are merely a guest or a co-host in.
 *
 * It exists because `completeUpload` validates the **grant**, not the account
 * state — so without this, an account suspended at 1am keeps completing uploads
 * for as long as its last grant lives.
 */
export async function expireGrantsForAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<number> {
  const [issued, started] = await Promise.all([
    ctx.db
      .query("uploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "issued"))
      .collect(),
    ctx.db
      .query("uploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "started"))
      .collect(),
  ]);
  const grants = [...issued, ...started];

  for (const grant of grants) {
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
  }
  return grants.length;
}
