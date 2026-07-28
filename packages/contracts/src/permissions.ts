import type { AccountState } from "./accounts";
import {
  acceptsUploads,
  isEditableEventState,
  isJoinableEventState,
  isViewableEventState,
  type EventState,
} from "./events";
import type { MediaState } from "./media";
import type { EventRole, Role } from "./roles";

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every permission-checked action in PartyBooth. Namespaced by the kind of
 * resource the action is performed *on*, which is also what decides the shape
 * of the `resource` argument to {@link can}.
 *
 * Adding an action here is a compile error everywhere it matters: the
 * capability matrix, the resource-kind map and the exhaustive test table are
 * all `Record<Action, …>`.
 */
export const ACTIONS = [
  // Platform / admin console.
  "platform.createEvent",
  "platform.inviteOrganiser",
  "platform.viewAdminConsole",
  "platform.viewAccounts",
  "platform.viewAuditLog",
  "platform.viewMedia",
  "platform.impersonateUser",

  // Events.
  "event.view",
  "event.update",
  "event.updateSchedule",
  "event.changeModerationMode",
  "event.changeState",
  "event.archive",
  "event.delete",
  "event.scheduleDeletion",
  "event.restoreDeletion",
  "event.transferOwnership",
  "event.viewInviteCode",
  "event.rotateInvite",
  "event.presentSlideshow",
  "event.viewStats",
  "event.join",

  // Memberships.
  "membership.list",
  "membership.inviteCohost",
  "membership.revokeCohostInvite",
  "membership.revoke",
  "membership.leave",

  // Media.
  "media.upload",
  "media.viewOwn",
  "media.viewApproved",
  "media.viewPending",
  "media.moderate",
  "media.withdrawOwn",
  "media.delete",
  "media.report",

  // Accounts.
  "account.view",
  "account.updateProfile",
  "account.requestDeletion",
  "account.registerPushDevice",
  "account.lock",
  "account.unlock",
  "account.scheduleDeletion",
  "account.restoreDeletion",
] as const;

export type Action = (typeof ACTIONS)[number];

export const RESOURCE_KINDS = ["platform", "event", "membership", "media", "account"] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Resources                                                                  */
/* -------------------------------------------------------------------------- */

export interface PlatformResource {
  kind: "platform";
  /**
   * Whether the acting account has been invited as an organiser. Private beta
   * is invitation-only, so this — not the role — is what gates event creation.
   */
  isOrganiser: boolean;
}

export interface EventResource {
  kind: "event";
  state: EventState;
}

export interface MembershipResource {
  kind: "membership";
  /** Role held by the membership being acted on. */
  targetRole: EventRole;
  /** Whether the membership belongs to the acting user. */
  isSelf: boolean;
  event: { state: EventState };
}

export interface MediaResource {
  kind: "media";
  state: MediaState;
  /** Whether the acting user submitted this media. */
  isOwn: boolean;
  event: { state: EventState };
}

export interface AccountResource {
  kind: "account";
  state: AccountState;
  /** Whether the account being acted on is the acting user's own. */
  isSelf: boolean;
}

export type Resource =
  PlatformResource | EventResource | MembershipResource | MediaResource | AccountResource;

/** Which resource shape each action requires. */
export const ACTION_RESOURCE_KIND = {
  "platform.createEvent": "platform",
  "platform.inviteOrganiser": "platform",
  "platform.viewAdminConsole": "platform",
  "platform.viewAccounts": "platform",
  "platform.viewAuditLog": "platform",
  "platform.viewMedia": "platform",
  "platform.impersonateUser": "platform",

  "event.view": "event",
  "event.update": "event",
  "event.updateSchedule": "event",
  "event.changeModerationMode": "event",
  "event.changeState": "event",
  "event.archive": "event",
  "event.delete": "event",
  "event.scheduleDeletion": "event",
  "event.restoreDeletion": "event",
  "event.transferOwnership": "event",
  "event.viewInviteCode": "event",
  "event.rotateInvite": "event",
  "event.presentSlideshow": "event",
  "event.viewStats": "event",
  "event.join": "event",

  "membership.list": "membership",
  "membership.inviteCohost": "membership",
  "membership.revokeCohostInvite": "membership",
  "membership.revoke": "membership",
  "membership.leave": "membership",

  "media.upload": "media",
  "media.viewOwn": "media",
  "media.viewApproved": "media",
  "media.viewPending": "media",
  "media.moderate": "media",
  "media.withdrawOwn": "media",
  "media.delete": "media",
  "media.report": "media",

  "account.view": "account",
  "account.updateProfile": "account",
  "account.requestDeletion": "account",
  "account.registerPushDevice": "account",
  "account.lock": "account",
  "account.unlock": "account",
  "account.scheduleDeletion": "account",
  "account.restoreDeletion": "account",
} as const satisfies Record<Action, ResourceKind>;

/** The resource type a given action expects — enforced by the compiler. */
export type ResourceFor<TAction extends Action> = Extract<
  Resource,
  { kind: (typeof ACTION_RESOURCE_KIND)[TAction] }
>;

/* -------------------------------------------------------------------------- */
/* Capability matrix (role → actions), independent of resource state           */
/* -------------------------------------------------------------------------- */

/**
 * The base grant: what a role may *ever* do, ignoring the state of the thing it
 * is acting on. {@link can} intersects this with the resource gates below.
 *
 * Deliberate holes, all from PLAN.md:
 *
 * - `globalAdmin` has **no** `media.*` capability at all and cannot impersonate.
 *   Admins manage accounts, events and audit; they never look at guests' photos.
 * - `cohost` **operates** the party and does not **own** it. That is the line
 *   PLAN.md draws ("co-hosts; invite rotation" under launch keeps, "no
 *   delete/transfer/ownership" in TODO.md) and it is the line this table draws:
 *   a co-host moderates, edits settings, moves the event between `live` and
 *   `paused`, presents the slideshow and rotates the invite; a co-host may not
 *   `event.delete`, `event.transferOwnership`, `event.archive` (ending the party
 *   is the owner's call), `event.scheduleDeletion`, `membership.inviteCohost` or
 *   `membership.revokeCohostInvite` — only the owner grows and shrinks the host
 *   list — and may not hard-delete another guest's media, only decline it.
 *
 *   Settings editing moved into the co-host set in Sprint 5, deliberately.
 *   PLAN.md's mitigation for risk #4 (solo moderation) is "co-hosts and
 *   `automatic` mode as a pressure valve", and a co-host who cannot reach the
 *   moderation-mode switch when the owner is on the dance floor is not a
 *   pressure valve. `membershipGate` still stops a co-host revoking themselves,
 *   the owner, or **another co-host**, so nothing here can be turned on the host.
 * - Nobody, ever, gets `platform.viewMedia` or `platform.impersonateUser`. They
 *   exist purely so the rule is written down and tested rather than implied.
 */
const CAPABILITIES = {
  globalAdmin: [
    "platform.inviteOrganiser",
    "platform.viewAdminConsole",
    "platform.viewAccounts",
    "platform.viewAuditLog",
    "event.view",
    "event.changeState",
    "event.archive",
    "event.scheduleDeletion",
    "event.restoreDeletion",
    "event.viewInviteCode",
    "event.rotateInvite",
    "event.viewStats",
    "membership.list",
    "membership.revoke",
    "account.view",
    "account.lock",
    "account.unlock",
    "account.scheduleDeletion",
    "account.restoreDeletion",
  ],
  owner: [
    "platform.createEvent",
    "event.view",
    "event.update",
    "event.updateSchedule",
    "event.changeModerationMode",
    "event.changeState",
    "event.archive",
    "event.delete",
    "event.scheduleDeletion",
    "event.transferOwnership",
    "event.viewInviteCode",
    "event.rotateInvite",
    "event.presentSlideshow",
    "event.viewStats",
    "membership.list",
    "membership.inviteCohost",
    "membership.revokeCohostInvite",
    "membership.revoke",
    "media.upload",
    "media.viewOwn",
    "media.viewApproved",
    "media.viewPending",
    "media.moderate",
    "media.withdrawOwn",
    "media.delete",
    "media.report",
    "account.view",
    "account.updateProfile",
    "account.requestDeletion",
    "account.registerPushDevice",
  ],
  cohost: [
    "platform.createEvent",
    "event.view",
    "event.update",
    "event.updateSchedule",
    "event.changeModerationMode",
    "event.changeState",
    "event.viewInviteCode",
    "event.rotateInvite",
    "event.presentSlideshow",
    "event.viewStats",
    "membership.list",
    "membership.revoke",
    "membership.leave",
    "media.upload",
    "media.viewOwn",
    "media.viewApproved",
    "media.viewPending",
    "media.moderate",
    "media.withdrawOwn",
    "media.report",
    "account.view",
    "account.updateProfile",
    "account.requestDeletion",
    "account.registerPushDevice",
  ],
  guest: [
    "platform.createEvent",
    "event.view",
    "event.join",
    "membership.leave",
    "media.upload",
    "media.viewOwn",
    "media.viewApproved",
    "media.withdrawOwn",
    "media.report",
    "account.view",
    "account.updateProfile",
    "account.requestDeletion",
    "account.registerPushDevice",
  ],
} as const satisfies Record<Role, readonly Action[]>;

const CAPABILITY_SETS: Record<Role, ReadonlySet<Action>> = {
  globalAdmin: new Set(CAPABILITIES.globalAdmin),
  owner: new Set(CAPABILITIES.owner),
  cohost: new Set(CAPABILITIES.cohost),
  guest: new Set(CAPABILITIES.guest),
};

/**
 * Base grant only — does the role ever get to do this, ignoring resource state?
 * Prefer {@link can}; this is exported for the exhaustive matrix test and for
 * UI that wants to hide a control outright rather than disable it.
 */
export function hasCapability(role: Role, action: Action): boolean {
  return CAPABILITY_SETS[role].has(action);
}

/** Every action a role can ever perform, in declaration order. */
export function capabilitiesOf(role: Role): readonly Action[] {
  return CAPABILITIES[role];
}

/* -------------------------------------------------------------------------- */
/* Resource gates (state- and ownership-dependent)                             */
/* -------------------------------------------------------------------------- */

function gate(role: Role, action: Action, resource: Resource): boolean {
  switch (resource.kind) {
    case "platform":
      // Private beta: only invited organisers create events. Everything else an
      // admin does is unconditional.
      return action === "platform.createEvent" ? resource.isOrganiser : true;

    case "event":
      return eventGate(action, resource.state);

    case "membership":
      return membershipGate(role, action, resource);

    case "media":
      return mediaGate(action, resource);

    case "account":
      return accountGate(role, action, resource);
  }
}

function eventGate(action: Action, state: EventState): boolean {
  switch (action) {
    case "event.join":
      return isJoinableEventState(state);

    case "event.update":
    case "event.updateSchedule":
    case "event.changeModerationMode":
    case "event.rotateInvite":
    case "event.viewInviteCode":
      return isEditableEventState(state);

    case "event.presentSlideshow":
      return isViewableEventState(state);

    case "event.archive":
      return state !== "archived" && state !== "deletionScheduled";

    case "event.changeState":
      // Restoring an event from `deletionScheduled` is an admin action and is
      // itself a state change, so this stays open in every state.
      return true;

    case "event.delete":
    case "event.transferOwnership":
    case "event.scheduleDeletion":
      return state !== "deletionScheduled";

    case "event.restoreDeletion":
      // The only action that *requires* the state it is undoing.
      return state === "deletionScheduled";

    default:
      // event.view, event.viewStats — readable in any state.
      return true;
  }
}

function membershipGate(role: Role, action: Action, resource: MembershipResource): boolean {
  switch (action) {
    case "membership.revoke":
      // You cannot revoke yourself (use leave), and an owner's membership can
      // only go away by transferring ownership or deleting the event.
      if (resource.isSelf || resource.targetRole === "owner") return false;
      // A co-host may remove a **guest** and nothing else. Removing another
      // co-host is managing the host list, which PLAN.md keeps with the owner
      // (and the admin console); without this line the two co-hosts of a party
      // could each remove the other, and the last one standing would be
      // whoever's phone had signal.
      if (role === "cohost" && resource.targetRole !== "guest") return false;
      return true;

    case "membership.leave":
      // Owners must hand the party over before walking out of it.
      return resource.isSelf && resource.targetRole !== "owner";

    case "membership.inviteCohost":
    case "membership.revokeCohostInvite":
      return isEditableEventState(resource.event.state);

    default:
      return true;
  }
}

function mediaGate(action: Action, resource: MediaResource): boolean {
  // Deleted media is gone for every purpose except the audit log.
  if (resource.state === "deleted") return false;

  switch (action) {
    case "media.upload":
      return acceptsUploads(resource.event.state);

    case "media.viewOwn":
    case "media.withdrawOwn":
      return resource.isOwn;

    case "media.viewApproved":
      return resource.state === "approved" && isViewableEventState(resource.event.state);

    case "media.moderate":
      return resource.state !== "processing";

    case "media.report":
      // Reporting your own upload is meaningless; withdraw it instead.
      return !resource.isOwn;

    default:
      // media.viewPending, media.delete — host powers, no extra state gate.
      return true;
  }
}

function accountGate(role: Role, action: Action, resource: AccountResource): boolean {
  if (resource.state === "deleted") return false;

  switch (action) {
    case "account.updateProfile":
    case "account.registerPushDevice":
      return resource.isSelf && resource.state === "active";

    case "account.requestDeletion":
      return resource.isSelf && resource.state !== "deletionScheduled";

    case "account.view":
      // Admins may inspect any account; everyone else only their own.
      return resource.isSelf || role === "globalAdmin";

    case "account.lock":
      // Guard against an admin locking themselves out of the console.
      return !resource.isSelf && resource.state === "active";

    case "account.unlock":
      return !resource.isSelf && resource.state === "locked";

    case "account.scheduleDeletion":
      return !resource.isSelf && resource.state !== "deletionScheduled";

    case "account.restoreDeletion":
      return resource.state === "deletionScheduled";

    default:
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* can()                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The single permission predicate. Pure, synchronous, no I/O — safe to call in
 * a Convex mutation, a React render and a unit test alike.
 *
 * ```ts
 * can("cohost", "media.moderate", {
 *   kind: "media",
 *   state: "pending",
 *   isOwn: false,
 *   event: { state: "live" },
 * }); // true
 * ```
 *
 * The `resource` argument is typed from the action, so passing an event where a
 * media resource belongs will not compile.
 *
 * This checks the **role**, not the actor's account state. Use {@link canAct}
 * on any real request path so that locked and deletion-scheduled accounts are
 * frozen out.
 */
export function can<TAction extends Action>(
  role: Role,
  action: TAction,
  resource: ResourceFor<TAction>,
): boolean {
  if (!hasCapability(role, action)) return false;
  if (resource.kind !== ACTION_RESOURCE_KIND[action]) return false;
  return gate(role, action, resource);
}

/* -------------------------------------------------------------------------- */
/* Account-state gate                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Actions a non-active account may still perform on itself. PLAN.md: a lock
 * "suspends owner/co-host access, joins, uploads and slideshows across owned
 * events", but the user must still be able to see their status and — for App
 * Review — delete their account from inside the app.
 */
const NON_ACTIVE_ACCOUNT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "account.view",
  "account.requestDeletion",
]);

/** Whether an actor in this account state may perform `action` at all. */
export function accountStateAllows(state: AccountState, action: Action): boolean {
  switch (state) {
    case "active":
      return true;
    case "locked":
      return NON_ACTIVE_ACCOUNT_ACTIONS.has(action);
    case "deletionScheduled":
      return action === "account.view";
    case "deleted":
      return false;
  }
}

export interface ActorContext {
  role: Role;
  /** State of the **acting** account (not the resource). */
  accountState: AccountState;
}

/**
 * `can()` plus the actor's account-state gate. This is what request handlers
 * should call; {@link can} on its own answers a narrower question.
 */
export function canAct<TAction extends Action>(
  actor: ActorContext,
  action: TAction,
  resource: ResourceFor<TAction>,
): boolean {
  if (!accountStateAllows(actor.accountState, action)) return false;
  return can(actor.role, action, resource);
}

/* -------------------------------------------------------------------------- */
/* Explained results (for error messages and audit reasons)                    */
/* -------------------------------------------------------------------------- */

export type DenialReason =
  "accountNotActive" | "roleLacksCapability" | "resourceMismatch" | "resourceState";

export type PermissionResult = { allowed: true } | { allowed: false; reason: DenialReason };

/**
 * Same decision as {@link canAct}, but says *why*. Use it where the answer ends
 * up in an error message or an audit row; use `canAct` where it ends up in an
 * `if`.
 */
export function explainCan<TAction extends Action>(
  actor: ActorContext,
  action: TAction,
  resource: ResourceFor<TAction>,
): PermissionResult {
  if (!accountStateAllows(actor.accountState, action)) {
    return { allowed: false, reason: "accountNotActive" };
  }
  if (!hasCapability(actor.role, action)) {
    return { allowed: false, reason: "roleLacksCapability" };
  }
  if (resource.kind !== ACTION_RESOURCE_KIND[action]) {
    return { allowed: false, reason: "resourceMismatch" };
  }
  if (!gate(actor.role, action, resource)) {
    return { allowed: false, reason: "resourceState" };
  }
  return { allowed: true };
}

export const DENIAL_MESSAGES: Record<DenialReason, string> = {
  accountNotActive: "This account is suspended or scheduled for deletion.",
  roleLacksCapability: "You do not have permission to do that.",
  resourceMismatch: "That action does not apply to this resource.",
  resourceState: "That action is not available right now.",
};
