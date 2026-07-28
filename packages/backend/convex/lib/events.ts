import {
  AUDIT_ACTIONS,
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
import { writeAuditEvent } from "./audit";
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
  options: InviteAllocationOptions & {
    ignoreEventId?: Id<"events"> | undefined;
    /**
     * Codes this draw must not return even though they look free.
     *
     * There is exactly one caller-visible reason for this and it is the whole
     * point of a rotation: the outgoing version's own code. `ignoreEventId`
     * takes the event's active version out of the "is it taken?" question so a
     * rotation can proceed at all, and that exemption used to let the draw hand
     * back the *same* six digits — a rotation that revokes the poster and then
     * reprints it. Every replacement code must differ from the one it replaces.
     */
    excludeCodes?: readonly string[] | undefined;
  } = {},
): Promise<string> {
  const excluded = new Set((options.excludeCodes ?? []).map((code) => normalizeEventCode(code)));
  return await generateUniqueEventCode(
    async (candidate) =>
      excluded.has(normalizeEventCode(candidate)) ||
      (await isCodeTaken(ctx, candidate, { ignoreEventId: options.ignoreEventId })),
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
 * A rotation that would leave the outgoing credential working.
 *
 * Thrown rather than quietly redrawn: the only way to reach it is an explicit
 * `specificCode` naming the code already in use, and silently substituting a
 * different one would tell the admin console their chosen value was applied
 * when it was not.
 */
export class InviteCodeUnchangedError extends Error {
  override readonly name = "InviteCodeUnchangedError";
  constructor() {
    super(
      "A rotation must change the code. Reusing the outgoing six digits would leave the credential the rotation exists to kill still working.",
    );
  }
}

/**
 * Create the next invite version for an event and retire the current one.
 *
 * Rotation is **additive**: the old row is marked `revoked`, never edited into
 * the new one, so "which QR was on the wall in July" stays answerable. A join
 * against the old code or token is rejected because the version it resolves to
 * is no longer `active`, which is the whole "kill the printed poster" story.
 *
 * Both credentials always change. The token is redrawn from 160 bits, so it
 * changes by construction; the code has to be *made* to change, because it is
 * drawn from a space small enough to repeat and the draw deliberately ignores
 * this event's own version — see {@link allocateJoinCode}.
 */
export async function mintInviteVersion(
  ctx: MutationCtx,
  params: MintInviteVersionParams,
): Promise<MintInviteVersionResult> {
  const { event, now } = params;
  const keep = params.keepExistingMemberships ?? true;

  const current = await getActiveInviteVersion(ctx, event);

  if (
    params.specificCode !== undefined &&
    current !== null &&
    normalizeEventCode(params.specificCode) === normalizeEventCode(current.code)
  ) {
    throw new InviteCodeUnchangedError();
  }

  const code =
    params.specificCode ??
    (await allocateJoinCode(ctx, {
      randomBytes: params.randomBytes,
      // The event's own outgoing code is about to be revoked, so it must not
      // block the draw — otherwise a specific-code rotation onto itself fails.
      ignoreEventId: event._id,
      // …but "does not block the draw" must not become "may be drawn again".
      ...(current === null ? {} : { excludeCodes: [current.code] }),
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

  const nextVersion = (current?.version ?? 0) + 1;

  const inviteVersionId = await ctx.db.insert("inviteVersions", {
    eventId: event._id,
    version: nextVersion,
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
    const revokeReason = params.reason ?? "Invite rotated without keeping memberships.";
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
        revokeReason,
      });
      // One row per person, not one aggregate count on the rotation. "Who was
      // removed from this party, and when" is the question the append-only log
      // exists to answer, and a rotation is by far the largest producer of
      // revocations in the product — the path that must not be the silent one.
      // `membership.revoked` is on AUDIT_ACTIONS_REQUIRING_REASON; the same
      // fallback sentence written to `revokeReason` satisfies it.
      await writeAuditEvent(ctx, {
        action: AUDIT_ACTIONS.membershipRevoked,
        subjectType: "membership",
        subjectId: membership._id,
        actor: { userId: params.createdByUserId },
        eventId: event._id,
        reason: revokeReason,
        metadata: {
          via: "inviteRotation",
          version: nextVersion,
          revokedUserId: membership.userId,
        },
        now,
      });
      revokedMembershipIds.push(membership._id);
    }
  }

  return {
    inviteVersionId,
    version: nextVersion,
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
 * the credential is replaced.
 *
 * **Replaced, not edited.** The obvious implementation is one `patch` that
 * writes a fresh code onto the existing row, and it is wrong twice over: an
 * `inviteVersions` row is the historical credential every membership admitted
 * under it points at, so rewriting it makes the log say guests joined with a
 * code that did not exist yet; and it silently rewrites a row the whole design
 * treats as immutable. So the current version is revoked and a new one minted,
 * exactly as a host-initiated rotation does, with memberships kept — nobody is
 * thrown out of a party for the host re-opening it.
 *
 * The QR token changes with it. Keeping the old token would be nice for anyone
 * still holding the printed sign, but it would mean one live version whose two
 * credentials came from different rows, and "which QR was on the wall" stops
 * having an answer. The re-open already tells the host their number changed;
 * the sign has to be reprinted either way.
 *
 * Returns the new code when one was needed, so the caller can put it in the
 * audit row and tell the host their printed number changed.
 */
export async function ensureCodeIsFree(
  ctx: MutationCtx,
  event: Doc<"events">,
  options: InviteAllocationOptions & {
    now: number;
    /** Who is answerable for the new version. The actor re-opening the event. */
    actorUserId: Id<"users">;
    reason?: string | undefined;
  },
): Promise<{ reissuedCode: string; version: number } | undefined> {
  const current = await getActiveInviteVersion(ctx, event);
  if (!current) return undefined;

  const clash = await isCodeTaken(ctx, current.code, { ignoreEventId: event._id });
  if (!clash) return undefined;

  const minted = await mintInviteVersion(ctx, {
    event,
    createdByUserId: options.actorUserId,
    // Re-opening is not a purge. Everyone who was at the party stays at it.
    keepExistingMemberships: true,
    reason: options.reason ?? "Re-opened event: the six-digit code had been reissued elsewhere.",
    now: options.now,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  });

  return { reissuedCode: minted.code, version: minted.version };
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
