import {
  eventJoinability,
  generateInviteToken,
  generateUniqueEventCode,
  isJoinableEventState,
  normalizeEventCode,
  normalizeInviteToken,
  type RandomBytes,
} from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getActiveMembership, type ReadCtx } from "./guards";

/**
 * Invite-version mechanics: allocating a six-digit code, minting a token, and
 * resolving one back to an event.
 *
 * The only subtle rule in here is what "unique" means for a code. It is
 * **unique among joinable events**, not globally, because six digits is a
 * million values and a beta that never freed a code would eventually exhaust
 * itself. The consequences are worth spelling out:
 *
 * - Archiving an event frees its code implicitly. Nothing is rewritten — the
 *   old `inviteVersions` row keeps the code, and the code stops counting
 *   because its event is no longer joinable. That means the row is still there
 *   to explain a join that happened last week, which a delete would destroy.
 * - Therefore a lookup by code can legitimately match **several** rows, so it
 *   collects and filters rather than calling `.unique()`, which would throw.
 * - Therefore re-opening an archived event (the after-party path the state
 *   machine allows) has to re-check its code — see {@link ensureCodeIsFree}.
 */

/** How many candidates to draw before giving up. See `generateUniqueEventCode`. */
const CODE_ATTEMPTS = 12;

export interface InviteAllocationOptions {
  /** Injectable randomness, for deterministic tests. */
  randomBytes?: RandomBytes | undefined;
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

export async function getActiveInviteVersion(
  ctx: ReadCtx,
  event: Doc<"events">,
): Promise<Doc<"inviteVersions"> | null> {
  if (event.activeInviteVersionId) {
    const version = await ctx.db.get(event.activeInviteVersionId);
    if (version && version.status === "active") return version;
  }
  // Fallback for a row whose pointer was never set — the index is the truth.
  const versions = await ctx.db
    .query("inviteVersions")
    .withIndex("by_event_and_status", (q) => q.eq("eventId", event._id).eq("status", "active"))
    .collect();
  return versions.at(-1) ?? null;
}

/**
 * Is this code currently spoken for?
 *
 * "Currently" means: held by an **active** invite version of an event in a
 * **joinable** state. A code on a revoked version, or on a version of an
 * archived event, is free to hand out again.
 */
export async function isCodeTaken(
  ctx: ReadCtx,
  code: string,
  options: { ignoreEventId?: Id<"events"> | undefined } = {},
): Promise<boolean> {
  const candidates = await ctx.db
    .query("inviteVersions")
    .withIndex("by_code", (q) => q.eq("code", normalizeEventCode(code)))
    .collect();

  for (const version of candidates) {
    if (version.status !== "active") continue;
    if (options.ignoreEventId && version.eventId === options.ignoreEventId) continue;
    const event = await ctx.db.get(version.eventId);
    if (event && isJoinableEventState(event.state)) return true;
  }
  return false;
}

/** Tokens are 160-bit, so this is belt and braces — but a collision must not silently share an event. */
export async function isTokenTaken(ctx: ReadCtx, token: string): Promise<boolean> {
  const existing = await ctx.db
    .query("inviteVersions")
    .withIndex("by_token", (q) => q.eq("token", normalizeInviteToken(token)))
    .first();
  return existing !== null;
}

export async function allocateJoinCode(
  ctx: ReadCtx,
  options: InviteAllocationOptions & { ignoreEventId?: Id<"events"> | undefined } = {},
): Promise<string> {
  return await generateUniqueEventCode(
    (candidate) => isCodeTaken(ctx, candidate, { ignoreEventId: options.ignoreEventId }),
    {
      maxAttempts: CODE_ATTEMPTS,
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    },
  );
}

export class InviteTokenCollisionError extends Error {
  override readonly name = "InviteTokenCollisionError";
  constructor() {
    super(
      "Could not allocate an unused invite token. A repeat across 160 bits is not chance — check the randomness source.",
    );
  }
}

export async function allocateInviteToken(
  ctx: ReadCtx,
  options: InviteAllocationOptions = {},
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateInviteToken(options.randomBytes);
    if (!(await isTokenTaken(ctx, candidate))) return candidate;
  }
  throw new InviteTokenCollisionError();
}

/* -------------------------------------------------------------------------- */
/* Minting a version                                                          */
/* -------------------------------------------------------------------------- */

export interface MintInviteVersionParams extends InviteAllocationOptions {
  event: Doc<"events">;
  createdByUserId: Id<"users">;
  /** Whether memberships admitted under the previous version survive. */
  keepExistingMemberships?: boolean | undefined;
  /** Admin-chosen code (already validated). Random when absent. */
  specificCode?: string | undefined;
  reason?: string | undefined;
  now: number;
}

export interface MintInviteVersionResult {
  inviteVersionId: Id<"inviteVersions">;
  version: number;
  code: string;
  token: string;
  /** Memberships revoked because the host chose not to keep them. */
  revokedMembershipIds: Id<"memberships">[];
  previousVersion: number | undefined;
}

/**
 * Create the next invite version for an event and retire the current one.
 *
 * Rotation is **additive**: the old row is marked `revoked`, never edited into
 * the new one, so "which QR was on the wall in July" stays answerable. A join
 * against the old code or token is rejected because the version it resolves to
 * is no longer `active`, which is the whole "kill the printed poster" story.
 */
export async function mintInviteVersion(
  ctx: MutationCtx,
  params: MintInviteVersionParams,
): Promise<MintInviteVersionResult> {
  const { event, now } = params;
  const keep = params.keepExistingMemberships ?? true;

  const current = await getActiveInviteVersion(ctx, event);

  const code =
    params.specificCode ??
    (await allocateJoinCode(ctx, {
      randomBytes: params.randomBytes,
      // The event's own outgoing code is about to be revoked, so it must not
      // block the draw — otherwise a specific-code rotation onto itself fails.
      ignoreEventId: event._id,
    }));
  const token = await allocateInviteToken(ctx, { randomBytes: params.randomBytes });

  if (current) {
    await ctx.db.patch(current._id, {
      status: "revoked",
      revokedAt: now,
      revokedByUserId: params.createdByUserId,
      ...(params.reason === undefined ? {} : { revokeReason: params.reason }),
    });
  }

  const inviteVersionId = await ctx.db.insert("inviteVersions", {
    eventId: event._id,
    version: (current?.version ?? 0) + 1,
    code,
    token,
    status: "active",
    keptExistingMemberships: keep,
    createdByUserId: params.createdByUserId,
    createdAt: now,
  });

  await ctx.db.patch(event._id, { activeInviteVersionId: inviteVersionId, updatedAt: now });

  const revokedMembershipIds: Id<"memberships">[] = [];
  if (!keep && current) {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_event_and_status", (q) => q.eq("eventId", event._id).eq("status", "active"))
      .collect();
    for (const membership of memberships) {
      // Hosts keep their seats: rotation is aimed at the guest list, and
      // locking the co-host out of the console mid-party helps nobody.
      if (membership.role !== "guest") continue;
      await ctx.db.patch(membership._id, {
        status: "revoked",
        revokedAt: now,
        revokedByUserId: params.createdByUserId,
        revokeReason: params.reason ?? "Invite rotated without keeping memberships.",
      });
      revokedMembershipIds.push(membership._id);
    }
  }

  return {
    inviteVersionId,
    version: (current?.version ?? 0) + 1,
    code,
    token,
    revokedMembershipIds,
    previousVersion: current?.version,
  };
}

/**
 * Guarantee the event's live code is unique among joinable events.
 *
 * Only one path can break that invariant: an archived event going back to
 * `live` after its code was reissued to somebody else. Rather than refuse the
 * re-open — the after-party is a real thing, and the state machine allows it —
 * the code is quietly redrawn. The token is left alone: it did not collide, and
 * a working QR is worth keeping.
 *
 * Returns the new code when one was needed, so the caller can put it in the
 * audit row and tell the host their printed number changed.
 */
export async function ensureCodeIsFree(
  ctx: MutationCtx,
  event: Doc<"events">,
  options: InviteAllocationOptions & { now: number } = { now: Date.now() },
): Promise<{ reissuedCode: string } | undefined> {
  const current = await getActiveInviteVersion(ctx, event);
  if (!current) return undefined;

  const clash = await isCodeTaken(ctx, current.code, { ignoreEventId: event._id });
  if (!clash) return undefined;

  const code = await allocateJoinCode(ctx, {
    randomBytes: options.randomBytes,
    ignoreEventId: event._id,
  });
  await ctx.db.patch(current._id, { code });
  return { reissuedCode: code };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedInvite {
  version: Doc<"inviteVersions">;
  event: Doc<"events">;
}

/**
 * Resolve a credential to an invite version and its event, **without judging
 * whether the join should succeed**.
 *
 * Deliberately split from the joinability check so the caller can record a
 * precise reason in the audit log while returning one indistinguishable answer
 * to the guest. It returns superseded versions too, for the same reason: "they
 * scanned last month's poster" is a different incident from "somebody is
 * guessing codes", and only the log gets to know which.
 */
export async function resolveInviteByCode(
  ctx: ReadCtx,
  code: string,
): Promise<ResolvedInvite | null> {
  const candidates = await ctx.db
    .query("inviteVersions")
    .withIndex("by_code", (q) => q.eq("code", normalizeEventCode(code)))
    .collect();

  let superseded: ResolvedInvite | null = null;

  for (const version of candidates) {
    const event = await ctx.db.get(version.eventId);
    if (!event) continue;
    if (version.status === "active" && isJoinableEventState(event.state)) {
      return { version, event };
    }
    superseded ??= { version, event };
  }
  return superseded;
}

export async function resolveInviteByToken(
  ctx: ReadCtx,
  token: string,
): Promise<ResolvedInvite | null> {
  const version = await ctx.db
    .query("inviteVersions")
    .withIndex("by_token", (q) => q.eq("token", normalizeInviteToken(token)))
    .unique();
  if (!version) return null;
  const event = await ctx.db.get(version.eventId);
  if (!event) return null;
  return { version, event };
}

/* -------------------------------------------------------------------------- */
/* Active-event selection                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Point a user at an event, but only if they are not already usefully pointed
 * at one.
 *
 * Called after a successful join, so the app lands on the party the guest just
 * walked into — without stealing focus from an event they are actively at, and
 * without leaving them on a selection that has since been archived or revoked.
 */
export async function adoptActiveEvent(
  ctx: MutationCtx,
  user: Doc<"users">,
  eventId: Id<"events">,
  now: number,
): Promise<void> {
  if (user.activeEventId) {
    const current = await ctx.db.get(user.activeEventId);
    if (current && current.state !== "deletionScheduled") {
      const membership = await getActiveMembership(ctx, current._id, user._id);
      if (membership) return;
    }
  }
  await ctx.db.patch(user._id, { activeEventId: eventId, updatedAt: now });
}

/* -------------------------------------------------------------------------- */
/* Joinability                                                                */
/* -------------------------------------------------------------------------- */

export type JoinabilityVerdict =
  | { joinable: true }
  | { joinable: false; reason: "revokedVersion" | "eventNotJoinable" | "outsideWindow" };

/**
 * The full gate: the invite version must be current, the event must be in a
 * joinable state, and now must fall inside the schedule window.
 *
 * The reason is for the audit log only.
 */
export function checkInviteJoinable(invite: ResolvedInvite, now: number): JoinabilityVerdict {
  if (invite.version.status !== "active") return { joinable: false, reason: "revokedVersion" };

  const verdict = eventJoinability(
    {
      state: invite.event.state,
      startsAt: invite.event.startsAt,
      ...(invite.event.endsAt === undefined ? {} : { endsAt: invite.event.endsAt }),
    },
    now,
  );
  return verdict.joinable ? { joinable: true } : { joinable: false, reason: verdict.reason };
}
