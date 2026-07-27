/**
 * Role and capability checks for the mobile shell.
 *
 * This module holds **no permission policy of its own**. Every answer below comes from
 * `@partybooth/contracts` — the same capability matrix `packages/backend` enforces in
 * Convex and `apps/web` renders against. What lives here is only the *adapter*: the
 * shell's local view model (`RoleContext`) mapped onto the contracts vocabulary
 * (`Role` + `AccountState` + `Action`).
 *
 * These are **affordance** checks — "should this tab exist", "should this button be
 * rendered" — so they ask {@link hasCapability}-level questions that need no resource.
 * The authoritative check always happens server-side in a Convex mutation via
 * `canAct()` with the real event/media row. Never treat a `true` from this file as
 * authorisation.
 */

import type { AccountState } from "@partybooth/contracts/accounts";
import { accountStateAllows, hasCapability, type Action } from "@partybooth/contracts/permissions";
import type { EventRole, Role } from "@partybooth/contracts/roles";

export { EVENT_ROLES, type EventRole } from "@partybooth/contracts/roles";

/**
 * Account-wide role, independent of any event.
 *
 * Deliberately *not* `@partybooth/contracts`'s `Role`: contracts folds `globalAdmin`
 * into the same enum as the event roles because a permission check takes exactly one
 * role. The shell needs both axes at once (you can be a global admin *and* a guest at
 * a party), so it keeps them apart and collapses them in {@link effectiveRole}.
 */
export const ACCOUNT_ROLES = ["globalAdmin", "member"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * Everything a capability check needs. `eventRole` is null when the user has not
 * joined the active event, or when there is no active event selected.
 */
export interface RoleContext {
  readonly accountRole: AccountRole;
  readonly eventRole: EventRole | null;
  /**
   * Set when the account is locked from `/admin`. TODO.md Sprint 5: a lock "suspends
   * owner/co-host access, joins, uploads, slideshows across owned events".
   */
  readonly accountLocked?: boolean;
}

/** The unauthenticated / not-yet-joined baseline. */
export const ANONYMOUS_ROLE_CONTEXT: RoleContext = {
  accountRole: "member",
  eventRole: null,
};

/**
 * The single contracts `Role` this context acts as, or `null` for "no role here".
 *
 * A global admin with no membership resolves to `null`, not `"globalAdmin"`: the admin
 * console is web-only and PLAN.md is explicit that admins get "no media access, no
 * impersonation". Handing the mobile shell a `globalAdmin` role would open a party's
 * moderation queue to someone who was never invited to it.
 */
function effectiveRole(ctx: RoleContext): Role | null {
  return ctx.eventRole;
}

function accountState(ctx: RoleContext): AccountState {
  return ctx.accountLocked === true ? "locked" : "active";
}

/**
 * The one place a decision is made. Both gates come from contracts:
 * the actor's account state, then the role's base capability.
 */
function allows(ctx: RoleContext, action: Action): boolean {
  const role = effectiveRole(ctx);
  if (role === null) return false;
  if (!accountStateAllows(accountState(ctx), action)) return false;
  return hasCapability(role, action);
}

/**
 * Whether the Host tab should be shown at all. Owners and co-hosts get it; plain
 * guests and signed-out users do not.
 */
export function canAccessHostTools(ctx: RoleContext): boolean {
  return allows(ctx, "media.viewPending");
}

/** Approve / decline submitted media. */
export function canModerateMedia(ctx: RoleContext): boolean {
  return allows(ctx, "media.moderate");
}

/** Rotate the six-digit code and QR token. */
export function canRotateInvite(ctx: RoleContext): boolean {
  return allows(ctx, "event.rotateInvite");
}

/**
 * Destructive event management — delete, transfer ownership. Owner only: co-hosts
 * explicitly get "no delete/transfer/ownership" (TODO.md Sprint 5).
 */
export function canManageEvent(ctx: RoleContext): boolean {
  return allows(ctx, "event.delete");
}

/** Submit photos and videos to the active event. Any joined, unlocked member. */
export function canSubmitMedia(ctx: RoleContext): boolean {
  return allows(ctx, "media.upload");
}
