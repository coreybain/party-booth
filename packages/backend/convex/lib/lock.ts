import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { forbidden } from "./errors";

/**
 * Spelled out here rather than imported from `./guards`, which imports *this*.
 * A type-only cycle would erase cleanly, but a module cycle that exists only in
 * the type layer is a cycle the next person has to reason about.
 */
type ReadCtx = QueryCtx | MutationCtx;

/**
 * The account-lock sweep.
 *
 * PLAN.md and TODO.md both say the same thing about a lock, and it is a bigger
 * claim than "that account cannot sign in":
 *
 * > Account lock enforcement: suspends owner/co-host access, joins, uploads,
 * > slideshows **across owned events**.
 *
 * The actor's own state was already enforced — `requireActiveUser`,
 * `accountStateAllows`, and the explicit `accountState !== "active"` checks in
 * `media`, `moderation` and `join`. What was not enforced is the *other* half:
 * an event whose **owner** is locked kept running. Guests joined it, uploaded to
 * it, and the co-host kept moderating and presenting the slideshow, because
 * every one of those checks asks about the caller and none of them asks about
 * the party. Locking a host from `/admin` at 1am and watching nothing happen is
 * exactly the failure RC5 is a demonstration against.
 *
 * So the freeze is a property of the **event**, resolved from its owner, and it
 * is asserted in `requireEventActor` — the one function every event-scoped read
 * and write in the product goes through — plus `join.ts`, which is the single
 * path that reaches an event without a membership. That placement is the whole
 * design: a sweep implemented as fifteen checks is a sweep with fifteen chances
 * to miss one, and the sixteenth surface added in Sprint 6 would have none.
 *
 * Two deliberate exemptions:
 *
 * - **A global admin passes through.** The console has to be able to look at the
 *   party it just froze, and at the account it is about to unlock. Admins have
 *   no `media.*` capability, so passing through buys them counts and states and
 *   not photographs.
 * - **`account.view` and `account.requestDeletion` are untouched**, because they
 *   are not event-scoped. A locked host must still be able to see that they are
 *   locked and to delete their account — App Review requires the second, and the
 *   first is the only thing that makes a lock appealable.
 */

export type EventFreezeReason = "ownerLocked" | "ownerDeletionScheduled" | "ownerDeleted";

export type EventFreeze = { frozen: false } | { frozen: true; reason: EventFreezeReason };

const NOT_FROZEN: EventFreeze = { frozen: false };

/** How an owner's account state maps onto their parties. */
export function freezeForOwnerState(state: Doc<"users">["accountState"]): EventFreeze {
  switch (state) {
    case "active":
      return NOT_FROZEN;
    case "locked":
      return { frozen: true, reason: "ownerLocked" };
    case "deletionScheduled":
      return { frozen: true, reason: "ownerDeletionScheduled" };
    case "deleted":
      return { frozen: true, reason: "ownerDeleted" };
  }
}

/**
 * Is this event frozen by its owner's account state?
 *
 * `knownOwner` exists so the common case costs no extra read: the actor
 * resolving their own party already holds the owner document.
 */
export async function eventFreeze(
  ctx: ReadCtx,
  event: Doc<"events">,
  knownOwner?: Doc<"users"> | null,
): Promise<EventFreeze> {
  const owner =
    knownOwner && knownOwner._id === event.ownerUserId
      ? knownOwner
      : await ctx.db.get(event.ownerUserId);
  // An event whose owner row has vanished is not a party anybody should be
  // walking into either. It is unreachable through the product's own paths, so
  // this is a fail-closed default rather than a case with a story.
  if (!owner) return { frozen: true, reason: "ownerDeleted" };
  return freezeForOwnerState(owner.accountState);
}

/**
 * What a guest is told.
 *
 * Deliberately vague about *why*: "the organiser's account is suspended" is a
 * fact about a third party's standing with us, told to thirty people at a party.
 * The audit log holds the real reason and the admin console shows it.
 */
export const EVENT_FREEZE_MESSAGES: Record<EventFreezeReason, string> = {
  ownerLocked: "This event is suspended. Ask the organiser to get in touch with us.",
  ownerDeletionScheduled: "This event is closed — the organiser's account is being removed.",
  ownerDeleted: "This event is no longer available.",
};

/** Throw unless the event is usable. A global admin is never refused. */
export async function assertEventNotFrozen(
  ctx: ReadCtx,
  event: Doc<"events">,
  options: { role?: string | undefined; knownOwner?: Doc<"users"> | null | undefined } = {},
): Promise<void> {
  if (options.role === "globalAdmin") return;
  const freeze = await eventFreeze(ctx, event, options.knownOwner ?? null);
  if (freeze.frozen) throw forbidden(EVENT_FREEZE_MESSAGES[freeze.reason]);
}

/** Non-throwing form, for the join path and for list views that filter. */
export async function eventIsUsable(ctx: ReadCtx, event: Doc<"events">): Promise<boolean> {
  return !(await eventFreeze(ctx, event)).frozen;
}
