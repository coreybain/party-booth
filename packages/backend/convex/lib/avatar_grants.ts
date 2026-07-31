import { generateSecret, type RandomBytes } from "@partybooth/contracts/codes";
import { AVATAR_GRANT_POLICY } from "@partybooth/contracts/avatar";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./guards";
import { sha256Hex } from "./hash";

import type { StorageRegion } from "@partybooth/contracts/storage";

const AVATAR_GRANT_SECRET_BYTES = 32;

export interface IssueAvatarGrantParams {
  userId: Id<"users">;
  storageRegion: StorageRegion;
  byteSize: number;
  mimeType: string;
  checksum: string;
  now: number;
  randomBytes?: RandomBytes | undefined;
}

export interface IssuedAvatarGrantRow {
  grantId: Id<"avatarUploadGrants">;
  /** Plaintext is returned once and never persisted. */
  secret: string;
  expiresAt: number;
}

/**
 * Issue one avatar grant and retire any older unspent one for this account.
 * There can be several historical rows, but only one live capability.
 */
export async function issueAvatarGrant(
  ctx: MutationCtx,
  params: IssueAvatarGrantParams,
): Promise<IssuedAvatarGrantRow> {
  await expireAvatarGrantsForAccount(ctx, params.userId, params.now);

  const secret = generateSecret(AVATAR_GRANT_SECRET_BYTES, params.randomBytes);
  const expiresAt = params.now + AVATAR_GRANT_POLICY.ttlMs;
  const grantId = await ctx.db.insert("avatarUploadGrants", {
    userId: params.userId,
    secretHash: await sha256Hex(secret),
    status: "issued",
    storageRegion: params.storageRegion,
    byteSize: params.byteSize,
    mimeType: params.mimeType,
    checksum: params.checksum,
    issuedAt: params.now,
    expiresAt,
    createdAt: params.now,
    updatedAt: params.now,
  });
  return { grantId, secret, expiresAt };
}

export async function findAvatarGrantBySecret(
  ctx: ReadCtx,
  secret: string,
): Promise<Doc<"avatarUploadGrants"> | null> {
  const secretHash = await sha256Hex(secret);
  return await ctx.db
    .query("avatarUploadGrants")
    .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
    .unique();
}

export type StartAvatarGrantResult =
  | { ok: true; grant: Doc<"avatarUploadGrants"> }
  | { ok: false; reason: "unknownGrant" }
  | {
      ok: false;
      reason: "expired" | "alreadyStarted" | "alreadyConsumed";
      grant: Doc<"avatarUploadGrants">;
    };

/** Reserve one avatar capability at authenticated edge preflight. */
export async function startAvatarGrant(
  ctx: MutationCtx,
  secret: string,
  expectedUserId: Id<"users">,
  now: number,
): Promise<StartAvatarGrantResult> {
  const grant = await findAvatarGrantBySecret(ctx, secret);
  if (!grant || grant.userId !== expectedUserId) return { ok: false, reason: "unknownGrant" };
  if (grant.status === "consumed") return { ok: false, reason: "alreadyConsumed", grant };
  if (grant.status === "started") return { ok: false, reason: "alreadyStarted", grant };
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

export type ConsumeAvatarGrantResult =
  | { ok: true; grant: Doc<"avatarUploadGrants"> }
  | { ok: false; reason: "unknownGrant" }
  | {
      ok: false;
      reason: "expired" | "notStarted" | "alreadyConsumed";
      grant: Doc<"avatarUploadGrants">;
    };

/** Spend a grant atomically, recording the provider key only on the grant row. */
export async function consumeAvatarGrant(
  ctx: MutationCtx,
  secret: string,
  fileKey: string,
  now: number,
): Promise<ConsumeAvatarGrantResult> {
  const grant = await findAvatarGrantBySecret(ctx, secret);
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
  return { ok: true, grant: consumed ?? grant };
}

export async function expireAvatarGrantsForAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<number> {
  const [issued, started] = await Promise.all([
    ctx.db
      .query("avatarUploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "issued"))
      .collect(),
    ctx.db
      .query("avatarUploadGrants")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "started"))
      .collect(),
  ]);
  const grants = [...issued, ...started];
  for (const grant of grants) {
    await ctx.db.patch(grant._id, { status: "expired", updatedAt: now });
  }
  return grants.length;
}
