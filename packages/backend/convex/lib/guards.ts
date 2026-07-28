import {
  accountStateAllows,
  DENIAL_MESSAGES,
  explainCan,
  hasEventRank,
  type Action,
  type EventRole,
  type ResourceFor,
  type Role,
} from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isAdminEmail, isDemoAddress } from "./config";
import { forbidden, isAppError, notFound, unauthenticated } from "./errors";

export type ReadCtx = QueryCtx | MutationCtx;

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in user, or `null`.
 *
 * `identity.subject` is the Better Auth user id; `users.authId` is the mirror
 * of it written by the trigger in `auth.ts`. Going through our own table (not
 * the auth component) keeps every read path on one index lookup and gives the
 * guards access to `accountState`, which the component knows nothing about.
 */
export async function getCurrentUser(ctx: ReadCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", identity.subject))
    .unique();
}

/** The signed-in user, or a `ConvexError` the client can branch on. */
export async function requireUser(ctx: ReadCtx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw unauthenticated();
  return user;
}

/**
 * The signed-in user, refusing anyone who is locked, scheduled for deletion or
 * deleted.
 *
 * Use this on every mutation. Read paths that a locked user is still allowed to
 * see (their own account, so they can find out *why*) should call
 * {@link requireUser} and check `accountState` themselves.
 */
export async function requireActiveUser(ctx: ReadCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.accountState !== "active") {
    throw forbidden(accountStateMessage(user.accountState));
  }
  return user;
}

function accountStateMessage(state: Doc<"users">["accountState"]): string {
  switch (state) {
    case "locked":
      return "This account has been suspended. Contact the organiser who invited you.";
    case "deletionScheduled":
      return "This account is scheduled for deletion.";
    case "deleted":
      return "This account no longer exists.";
    default:
      return "This account cannot perform that action.";
  }
}

/**
 * A global admin.
 *
 * The **allowlist is the authority**, not `users.isGlobalAdmin` — that column
 * is a cache for queries, and a stale or tampered value must not be enough to
 * get into `/admin`.
 */
export async function requireGlobalAdmin(ctx: ReadCtx): Promise<Doc<"users">> {
  const user = await requireActiveUser(ctx);
  if (!isAdminEmail(user.email)) {
    // Deliberately the same message a non-admin sees anywhere else: the
    // existence of the console is not a secret, but membership of it is not
    // worth confirming either.
    throw forbidden();
  }
  return user;
}

/* -------------------------------------------------------------------------- */
/* Event actors                                                               */
/* -------------------------------------------------------------------------- */

export interface EventActor {
  user: Doc<"users">;
  event: Doc<"events">;
  /** The role this user holds *for this event*. */
  role: Role;
  /** `null` for a global admin acting without a membership. */
  membership: Doc<"memberships"> | null;
}

export async function getActiveMembership(
  ctx: ReadCtx,
  eventId: Id<"events">,
  userId: Id<"users">,
): Promise<Doc<"memberships"> | null> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_event_and_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
    .unique();
  return membership && membership.status === "active" ? membership : null;
}

/**
 * Work out what role a user holds for an event.
 *
 * Ownership wins over admin: someone who is both a platform admin and the host
 * of this party is acting as the host, and should keep the host's powers
 * (including moderation, which admins deliberately do not have).
 */
export async function resolveEventRole(
  ctx: ReadCtx,
  event: Doc<"events">,
  user: Doc<"users">,
): Promise<{ role: Role; membership: Doc<"memberships"> | null } | null> {
  if (event.ownerUserId === user._id) {
    return { role: "owner", membership: await getActiveMembership(ctx, event._id, user._id) };
  }

  const membership = await getActiveMembership(ctx, event._id, user._id);
  if (membership) return { role: membership.role, membership };

  if (isAdminEmail(user.email)) return { role: "globalAdmin", membership: null };

  return null;
}

/**
 * Resolve the acting user and their role for an event in one go.
 *
 * Throws `notFound` — not `forbidden` — for a user with no relationship to the
 * event, so that guessing event ids cannot be used to enumerate which ones
 * exist.
 */
export async function requireEventActor(ctx: ReadCtx, eventId: Id<"events">): Promise<EventActor> {
  const user = await requireUser(ctx);
  const event = await ctx.db.get(eventId);
  if (!event) throw notFound("That event");

  assertDemoConfinement(user, event);

  const resolved = await resolveEventRole(ctx, event, user);
  if (!resolved) throw notFound("That event");

  return { user, event, role: resolved.role, membership: resolved.membership };
}

/**
 * The App Review demo identity may touch the demo party and nothing else.
 *
 * The reviewer credential is a **published** address and a **published** fixed
 * six-digit code, deliberately enabled against the deployment Apple reviews —
 * which on 5 August is the deployment the real party runs on, so there is no
 * environment marker that can separate the two (see `lib/config.ts`). The
 * argument that the credential "unlocks a party with no real people in it" held
 * only for as long as nobody invited it anywhere else: a code on a printed sign,
 * or a QR photographed at the door, was enough for anyone holding the published
 * credentials to join a real party and start uploading and reporting inside it.
 *
 * So the identity is confined rather than trusted. This runs before the role is
 * resolved, so it covers every event-scoped read and write in the product at
 * once, and it answers `notFound` for the same reason the role check does.
 * `join.ts` calls it separately, because joining is the one path that reaches an
 * event without a membership.
 *
 * It is a no-op on every deployment that has not opted in: with the demo
 * variables unset — or expired — `isDemoAddress` is `false` for everybody.
 */
export function assertDemoConfinement(user: Doc<"users">, event: Doc<"events">): void {
  if (!isDemoAddress(user.email)) return;
  if (event.isDemo === true) return;
  throw notFound("That event");
}

/** Non-throwing form, for the join path, which reports refusals as values. */
export function demoConfinementAllows(user: Doc<"users">, event: Doc<"events">): boolean {
  return !isDemoAddress(user.email) || event.isDemo === true;
}

/**
 * {@link requireEventActor}, with its refusal rewritten to the caller's subject.
 *
 * Every handler that looks a **media row** up by id and *then* resolves its
 * event had two distinguishable refusals for one question: `notFound("That
 * photo")` for an id that does not exist, and `notFound("That event")` for a
 * real row in a party the caller is not in. Media ids are stable and are handed
 * out as `MediaView.id`, so the pair let an authenticated user confirm that an
 * id belongs to a party they were never invited to — which is exactly what
 * `requireEventActor` answering `notFound` rather than `forbidden` exists to
 * prevent. Rewriting the message here restores it in one place for
 * `media.withdraw` and `moderation.report` alike.
 *
 * Only the `notFound` refusal is rewritten. An unauthenticated caller still
 * learns they are signed out, because that is actionable and discloses nothing.
 */
export async function requireEventActorFor(
  ctx: ReadCtx,
  eventId: Id<"events">,
  subject: string,
): Promise<EventActor> {
  try {
    return await requireEventActor(ctx, eventId);
  } catch (error) {
    if (isAppError(error) && error.data.code === "notFound") throw notFound(subject);
    throw error;
  }
}

/**
 * Require at least `minimum` seniority within the event (`guest` < `cohost` <
 * `owner`). A global admin does **not** satisfy this: admin powers are a
 * separate axis and never include host powers over someone else's party.
 */
export async function requireEventRole(
  ctx: ReadCtx,
  eventId: Id<"events">,
  minimum: EventRole,
): Promise<EventActor> {
  const actor = await requireEventActor(ctx, eventId);
  if (actor.role === "globalAdmin" || !hasEventRank(actor.role, minimum)) {
    throw forbidden();
  }
  return actor;
}

/* -------------------------------------------------------------------------- */
/* Permission checks                                                          */
/* -------------------------------------------------------------------------- */

export interface PermissionActor {
  role: Role;
  accountState: Doc<"users">["accountState"];
}

/**
 * Enforce a rule from `@partybooth/contracts`.
 *
 * All the actual policy lives in `can()` / `canAct()`, which are pure and
 * exhaustively tested; this only turns a `false` into the right `ConvexError`
 * with the right message.
 */
export function requirePermission<TAction extends Action>(
  actor: PermissionActor,
  action: TAction,
  resource: ResourceFor<TAction>,
): void {
  const result = explainCan(
    { role: actor.role, accountState: actor.accountState },
    action,
    resource,
  );
  if (result.allowed) return;
  throw forbidden(DENIAL_MESSAGES[result.reason]);
}

/** Non-throwing form, for deciding whether to render a control. */
export function checkPermission<TAction extends Action>(
  actor: PermissionActor,
  action: TAction,
  resource: ResourceFor<TAction>,
): boolean {
  return explainCan({ role: actor.role, accountState: actor.accountState }, action, resource)
    .allowed;
}

/** Whether this actor's account state permits `action` at all. */
export function accountPermits(user: Doc<"users">, action: Action): boolean {
  return accountStateAllows(user.accountState, action);
}

/** Convenience: the actor shape the permission functions want. */
export function toPermissionActor(user: Doc<"users">, role: Role): PermissionActor {
  return { role, accountState: user.accountState };
}
