import {
  accountJoinKey,
  AUDIT_ACTIONS,
  joinEventInputSchema,
  joinRejected,
  joinThrottled,
  networkJoinKey,
  type JoinInput,
  type JoinRejectionReason,
  type JoinResult,
} from "@partybooth/contracts";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { applyVerifiedEmailMatching } from "./lib/email-matching";
import {
  adoptActiveEvent,
  checkInviteJoinable,
  resolveInviteByCode,
  resolveInviteByToken,
  type ResolvedInvite,
} from "./lib/events";
import { requireActiveUser, type ReadCtx } from "./lib/guards";
import { sha256Hex } from "./lib/hash";
import { parseInput } from "./lib/input";
import { checkJoinThrottle, recordJoinFailure } from "./lib/join-throttle";
import { eventState } from "./lib/validators";

/**
 * The join flow.
 *
 * PLAN.md: "authenticated, rate-limited, enumeration-protected and audited".
 * All four, in that order, and the third is the one with teeth:
 *
 * > a six-digit code is only a million values, so failed-join responses must
 * > not distinguish "no such event" from "wrong version" from "not live".
 *
 * So every failure returns the *same value* — `joinRejected()`, one string,
 * built in `@partybooth/contracts` so it cannot drift. The real reason is
 * written to `auditEvents`, where it belongs: "they scanned last month's
 * poster" and "somebody is walking the keyspace" need to be told apart by us
 * and by nobody else.
 *
 * Failures are values rather than exceptions on purpose. A thrown error is a
 * different code path with different timing and a different shape on the wire,
 * and three of those is an oracle.
 *
 * Three invariants hold across every entry point in this file, and each one is
 * here because breaking it was an audit finding:
 *
 * 1. **One evaluator.** {@link evaluateCredential} is the only thing that turns
 *    a credential into a verdict, so `join` and `previewByCode` cannot disagree
 *    about what a revoked version means. The preview used to run its own
 *    joinability check and then record *every* refusal as `unknownCredential`,
 *    which made the audit log — the one place the reason survives — wrong
 *    precisely when it mattered.
 * 2. **Every attempt leaves a row.** Accepted, rejected or throttled, by code or
 *    by token, join or preview. A valid credential replayed a thousand times
 *    used to leave one row from its first use; a preview at the throttle
 *    ceiling used to leave none at all, so an attacker went dark exactly when
 *    they were most interesting.
 * 3. **Nothing but time returns budget.** There is no success reset — see
 *    `lib/join-throttle.ts`.
 */

const inviteArg = v.union(
  v.object({ via: v.literal("token"), token: v.string() }),
  v.object({ via: v.literal("code"), code: v.string() }),
);

const joinResultValidator = v.union(
  v.object({
    outcome: v.literal("joined"),
    eventId: v.id("events"),
    membershipId: v.id("memberships"),
    role: v.union(v.literal("owner"), v.literal("cohost"), v.literal("guest")),
    alreadyMember: v.boolean(),
  }),
  v.object({ outcome: v.literal("rejected"), message: v.string() }),
  v.object({
    outcome: v.literal("throttled"),
    message: v.string(),
    retryAfterMs: v.number(),
  }),
);

/* -------------------------------------------------------------------------- */
/* Throttle keys                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which keys this attempt is charged to.
 *
 * The account key always exists — joining is authenticated — and it is the only
 * one that is *guaranteed* to be charged. The network key is additive and comes
 * from a server-side origin: `apps/web` posts joins and code previews through
 * `/api/join`, which derives the key from the request's forwarded address and
 * passes it here, where it is hashed so the throttle table never holds a raw
 * address.
 *
 * It is **not trusted**, and the code above must never read as if it were: a
 * caller reaching this mutation directly over the Convex socket (the Expo app
 * does, by design — it has no server in front of it) simply omits it. Because a
 * supplied key can only ever *add* a key to be throttled on, forging one costs
 * the forger and helps nobody. What it cannot do is remove the account key, and
 * that is the whole security argument for accepting it from a client at all.
 */
async function throttleKeys(
  userId: Id<"users">,
  networkKey: string | undefined,
): Promise<string[]> {
  const keys = [accountJoinKey(userId)];
  if (networkKey !== undefined && networkKey.trim() !== "") {
    keys.push(networkJoinKey(await sha256Hex(networkKey.trim())));
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* Evaluating a credential                                                    */
/* -------------------------------------------------------------------------- */

interface CredentialAccepted {
  ok: true;
  invite: ResolvedInvite;
  /** Any existing row for this user and event, whatever its status. */
  membership: Doc<"memberships"> | null;
}

interface CredentialRefused {
  ok: false;
  /** Audit-log only. Never returned to the caller in any form. */
  reason: JoinRejectionReason;
  /** Known for everything except an unresolvable credential. */
  eventId?: Id<"events"> | undefined;
}

type CredentialVerdict = CredentialAccepted | CredentialRefused;

/**
 * Resolve a credential and decide whether this account may walk in — once, for
 * every caller.
 *
 * The verdict keeps the *reason* internally and the callers throw it away on
 * the way out; that split is the enumeration protection, and it only works if
 * there is one place the reason is computed. `userId` is nullable because
 * `previewByToken` is unauthenticated: with no account there is no membership
 * to have been revoked, and a 160-bit token has nothing to enumerate.
 */
async function evaluateCredential(
  ctx: ReadCtx,
  input: JoinInput,
  userId: Id<"users"> | null,
  now: number,
): Promise<CredentialVerdict> {
  const invite =
    input.via === "token"
      ? await resolveInviteByToken(ctx, input.token)
      : await resolveInviteByCode(ctx, input.code);

  if (!invite) return { ok: false, reason: "unknownCredential" };

  const verdict = checkInviteJoinable(invite, now);
  if (!verdict.joinable) {
    return { ok: false, reason: verdict.reason, eventId: invite.event._id };
  }

  if (userId === null) return { ok: true, invite, membership: null };

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_event_and_user", (q) => q.eq("eventId", invite.event._id).eq("userId", userId))
    .unique();

  // A host removed this person. A fresh scan of the same QR must not undo
  // that — only a co-host invite or a rotation that keeps memberships does.
  // The preview answers the same way, so "can I see it" and "can I join it"
  // never disagree.
  if (membership?.status === "revoked") {
    return { ok: false, reason: "membershipRevoked", eventId: invite.event._id };
  }

  return { ok: true, invite, membership };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Charge the failure and record why, for joins and previews alike.
 *
 * Separated from {@link reject} so `previewByCode` can reuse it and still
 * return its own uniform `null`. The `preview` flag is the only thing that
 * distinguishes the two in the log, and it is there because "somebody probed
 * two hundred codes without ever trying to join" is a different story from
 * "somebody mistyped".
 */
async function recordRejection(
  ctx: MutationCtx,
  params: {
    keys: readonly string[];
    userId: Id<"users">;
    reason: JoinRejectionReason | "throttled";
    via: "code" | "token";
    preview?: boolean | undefined;
    /** A throttled attempt is refused before it is read, so nothing is charged. */
    charge?: boolean | undefined;
    eventId?: Id<"events"> | undefined;
    now: number;
  },
): Promise<void> {
  if (params.charge !== false) await recordJoinFailure(ctx, params.keys, params.now);
  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.joinRejected,
    subjectType: "membership",
    actor: { userId: params.userId },
    eventId: params.eventId,
    metadata: {
      reason: params.reason,
      via: params.via,
      ...(params.preview === true ? { preview: true } : {}),
    },
    now: params.now,
  });
}

/**
 * Record a failure and return the one rejection value.
 *
 * Every caller returns exactly what this returns; nothing branches on the
 * reason after this point.
 */
async function reject(
  ctx: MutationCtx,
  params: {
    keys: readonly string[];
    userId: Id<"users">;
    reason: JoinRejectionReason;
    via: "code" | "token";
    eventId?: Id<"events"> | undefined;
    now: number;
  },
): Promise<JoinResult<Id<"events">, Id<"memberships">>> {
  await recordRejection(ctx, params);
  return joinRejected();
}

/* -------------------------------------------------------------------------- */
/* join                                                                       */
/* -------------------------------------------------------------------------- */

export const join = mutation({
  args: {
    invite: inviteArg,
    /**
     * An opaque per-client value (`apps/web`'s `/api/join` route passes a
     * hashed forwarded address). Untrusted: it is hashed again here and can
     * only ever *add* a throttle key. See {@link throttleKeys}.
     */
    networkKey: v.optional(v.string()),
  },
  returns: joinResultValidator,
  handler: async (ctx, args): Promise<JoinResult<Id<"events">, Id<"memberships">>> => {
    // A locked or deletion-scheduled account is refused before anything else.
    // That is not an enumeration leak: it is a fact about the caller's own
    // account, which they already know.
    const user = await requireActiveUser(ctx);

    const input = parseInput(joinEventInputSchema, args.invite);
    const now = Date.now();
    const keys = await throttleKeys(user._id, args.networkKey);

    const throttle = await checkJoinThrottle(ctx, keys, now);
    if (!throttle.allowed) {
      await recordRejection(ctx, {
        keys,
        userId: user._id,
        reason: "throttled",
        via: input.via,
        charge: false,
        now,
      });
      return joinThrottled(throttle.retryAfterMs);
    }

    const verdict = await evaluateCredential(ctx, input, user._id, now);
    if (!verdict.ok) {
      return await reject(ctx, {
        keys,
        userId: user._id,
        reason: verdict.reason,
        via: input.via,
        eventId: verdict.eventId,
        now,
      });
    }

    const result = await admit(ctx, {
      user,
      invite: verdict.invite,
      existing: verdict.membership,
      via: input.via,
      now,
    });

    await adoptActiveEvent(ctx, user, verdict.invite.event._id, now);
    return result;
  },
});

/**
 * Create or refresh the membership, then let verified-email matching have the
 * last word on the role.
 *
 * Everyone comes in as a `guest`. Matching is what turns a verified address
 * into a co-host seat, so a host who was invited by email before they had an
 * account still lands with host powers on the first scan — and a guest cannot
 * assert one, because the only input is an address a provider or an OTP
 * vouched for.
 */
async function admit(
  ctx: MutationCtx,
  params: {
    user: Doc<"users">;
    invite: ResolvedInvite;
    existing: Doc<"memberships"> | null;
    via: "code" | "token";
    now: number;
  },
): Promise<JoinResult<Id<"events">, Id<"memberships">>> {
  const { user, invite, existing, now } = params;

  const alreadyMember = existing?.status === "active";
  const priorStatus = existing?.status ?? "none";
  let membershipId: Id<"memberships">;

  if (existing) {
    membershipId = existing._id;
    if (!alreadyMember) {
      // "left" — they walked out and came back. Same row, fresh version.
      await ctx.db.patch(existing._id, {
        status: "active",
        inviteVersionId: invite.version._id,
        joinedAt: now,
      });
    } else if (existing.inviteVersionId !== invite.version._id) {
      // Re-scanning after a rotation that kept memberships: move them onto the
      // current version so the next rotation can revoke them cleanly.
      await ctx.db.patch(existing._id, { inviteVersionId: invite.version._id });
    }
  } else {
    membershipId = await ctx.db.insert("memberships", {
      eventId: invite.event._id,
      userId: user._id,
      role: invite.event.ownerUserId === user._id ? "owner" : "guest",
      status: "active",
      inviteVersionId: invite.version._id,
      joinedAt: now,
    });
  }

  // `membership.created` means a row appeared, and nothing else. Re-activating
  // a `left` membership is not a creation — the row was already there, and
  // logging it as one made "how many people joined this party" wrong and hid
  // the more interesting fact that somebody came back.
  if (existing === null) {
    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.membershipCreated,
      subjectType: "membership",
      subjectId: membershipId,
      actor: { userId: user._id },
      eventId: invite.event._id,
      metadata: { via: params.via, inviteVersion: invite.version.version },
      now,
    });
  }

  // …and this is written for *every* admitted attempt, including the repeat
  // scans that change nothing. A credential being used is the audited event;
  // whether it happened to create a row is a detail of that event, carried in
  // the metadata rather than deciding whether there is a row at all.
  await writeAuditEvent(ctx, {
    action: AUDIT_ACTIONS.joinSucceeded,
    subjectType: "membership",
    subjectId: membershipId,
    actor: { userId: user._id },
    eventId: invite.event._id,
    metadata: {
      via: params.via,
      inviteVersion: invite.version.version,
      alreadyMember,
      priorStatus,
    },
    now,
  });

  // May upgrade the row just written to `cohost`, or unlock organiser powers.
  await applyVerifiedEmailMatching(ctx, user, { now });

  const settled = await ctx.db.get(membershipId);
  return {
    outcome: "joined",
    eventId: invite.event._id,
    membershipId,
    role: settled?.role ?? "guest",
    alreadyMember,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

const previewValidator = v.union(
  v.null(),
  v.object({
    eventId: v.id("events"),
    name: v.string(),
    state: eventState,
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    timeZone: v.string(),
    accentColor: v.optional(v.string()),
    coverKey: v.optional(v.string()),
    hostDisplayName: v.string(),
    /** `true` when this account is already in — the UI says "open" not "join". */
    alreadyMember: v.boolean(),
  }),
);

interface PreviewPayload {
  eventId: Id<"events">;
  name: string;
  state: Doc<"events">["state"];
  startsAt: number;
  endsAt?: number;
  timeZone: string;
  accentColor?: string;
  coverKey?: string;
  hostDisplayName: string;
  alreadyMember: boolean;
}

/**
 * Render an accepted verdict as the thin payload a join screen shows.
 *
 * Deliberately thin: the name, when, and whose party it is. No counts, no
 * guest list, no media — a preview is a "yes, this is the right party" check,
 * not a window into it.
 */
async function renderPreview(ctx: ReadCtx, accepted: CredentialAccepted): Promise<PreviewPayload> {
  const { event } = accepted.invite;
  const owner = await ctx.db.get(event.ownerUserId);

  return {
    eventId: event._id,
    name: event.name,
    state: event.state,
    startsAt: event.startsAt,
    ...(event.endsAt === undefined ? {} : { endsAt: event.endsAt }),
    timeZone: event.timeZone,
    ...(event.accentColor === undefined ? {} : { accentColor: event.accentColor }),
    ...(event.coverKey === undefined ? {} : { coverKey: event.coverKey }),
    hostDisplayName: owner?.displayName ?? "The host",
    alreadyMember: accepted.membership?.status === "active",
  };
}

/**
 * Preview from a QR / universal link.
 *
 * A **query**, and unauthenticated, because the token is 160 bits: there is
 * nothing to enumerate, and the join page has to render something before the
 * guest has signed in. `null` covers "no such token", "superseded" and "not
 * joinable" alike. A query cannot write, so there is no throttle and no audit
 * row here — the credential is its own protection.
 */
export const previewByToken = query({
  args: { token: v.string() },
  returns: previewValidator,
  handler: async (ctx, args): Promise<PreviewPayload | null> => {
    const identityUser = await ctx.auth.getUserIdentity();
    const user = identityUser
      ? await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", identityUser.subject))
          .unique()
      : null;

    const input = joinEventInputSchema.safeParse({ via: "token", token: args.token });
    if (!input.success) return null;

    const verdict = await evaluateCredential(ctx, input.data, user?._id ?? null, Date.now());
    return verdict.ok ? await renderPreview(ctx, verdict) : null;
  },
});

/**
 * Preview from a typed six-digit code.
 *
 * A **mutation**, which looks wrong and is not. Six digits is a million values;
 * an unthrottled query that answers "is this a real code?" is exactly the
 * oracle the whole join flow is built to deny. Only a mutation can spend a
 * throttle budget, so this one is authenticated, charged against the same keys
 * as a join, and returns the same `null` for every failure.
 *
 * It is audited on exactly the same terms as a join, and that is not
 * decoration: this is the endpoint a code-walker actually calls, so a silent
 * refusal here is a blind spot in the only mechanism that can tell a guesser
 * from a guest. The uniform `null` is what the caller sees; the reason goes to
 * the log.
 */
export const previewByCode = mutation({
  args: { code: v.string(), networkKey: v.optional(v.string()) },
  returns: previewValidator,
  handler: async (ctx, args): Promise<PreviewPayload | null> => {
    const user = await requireActiveUser(ctx);
    const input = parseInput(joinEventInputSchema, { via: "code", code: args.code });
    if (input.via !== "code") return null;

    const now = Date.now();
    const keys = await throttleKeys(user._id, args.networkKey);

    if (!(await checkJoinThrottle(ctx, keys, now)).allowed) {
      await recordRejection(ctx, {
        keys,
        userId: user._id,
        reason: "throttled",
        via: "code",
        preview: true,
        charge: false,
        now,
      });
      return null;
    }

    const verdict = await evaluateCredential(ctx, input, user._id, now);

    if (!verdict.ok) {
      await recordRejection(ctx, {
        keys,
        userId: user._id,
        reason: verdict.reason,
        via: "code",
        preview: true,
        eventId: verdict.eventId,
        now,
      });
      return null;
    }

    return await renderPreview(ctx, verdict);
  },
});
