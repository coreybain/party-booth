import {
  accountStateMachine,
  eventStateMachine,
  type AccountState,
  type EventState,
} from "@/lib/contracts";
import type { AdminAccount, AdminEvent } from "@/lib/convex-api";

/**
 * Which privileged actions a row is offered, and what each one says.
 *
 * The list is **derived from the state machines**, not hand-written: an account
 * is offered "Lock" exactly when `active → locked` is a legal transition, and
 * "Restore" exactly when it is sitting in `deletionScheduled`. The alternative —
 * a `switch` in the table component — is a second copy of a table Convex already
 * owns, and the way that fails is a console offering a button whose only outcome
 * is an `invalidState` error at 1 a.m.
 *
 * Every entry carries its own confirmation copy, because the sentence a person
 * reads before pressing an irreversible button is part of the control and not
 * decoration. `tone: "danger"` is reserved for the ones that take something
 * away from somebody who is not in the room.
 */

export type AdminAccountAction = "lock" | "unlock" | "scheduleDeletion" | "restore";
export type AdminEventAction = "rotateCode" | "scheduleDeletion" | "restore";

export interface AdminActionCopy {
  /** The button. */
  readonly label: string;
  /** The dialog's heading. */
  readonly title: string;
  /** What actually happens, in the order it happens. */
  readonly consequences: readonly string[];
  /** The dialog's confirm button. */
  readonly confirmLabel: string;
  readonly tone: "danger" | "primary";
}

export const ACCOUNT_ACTION_COPY: Record<AdminAccountAction, AdminActionCopy> = {
  lock: {
    label: "Lock",
    title: "Lock this account?",
    consequences: [
      "They lose access immediately — console, uploads and slideshow.",
      "Every party they own freezes: co-hosts stop moderating, guests stop uploading, and nobody new can join off a printed QR.",
      "Every outstanding upload permission is cancelled — the account's own, and every guest's for the parties it owns.",
      "Image links already handed out keep working for up to ten minutes; nothing new is issued.",
      "Guests are told the party is unavailable. They are never told whose account it is.",
      "Nothing is deleted, and unlocking puts it all back.",
    ],
    confirmLabel: "Lock the account",
    tone: "danger",
  },
  unlock: {
    label: "Unlock",
    title: "Unlock this account?",
    consequences: [
      "They get their console back, and every party they own starts working again.",
      "Guests who were mid-upload have to send again — every permission issued before the lock was cancelled.",
    ],
    confirmLabel: "Unlock the account",
    tone: "primary",
  },
  scheduleDeletion: {
    label: "Schedule deletion",
    title: "Schedule this account for deletion?",
    consequences: [
      "Access is revoked immediately, exactly as a lock does — including every outstanding upload permission.",
      "Thirty days from now the account, its media and its stored files are erased for good.",
      "Their submissions stay in other people's parties until then, with the name removed.",
      "It is reversible until the purge runs — 'Restore' brings the account back.",
    ],
    confirmLabel: "Schedule deletion",
    tone: "danger",
  },
  restore: {
    label: "Restore",
    title: "Cancel this account's deletion?",
    consequences: [
      "The pending purge job is cancelled and the account becomes active again.",
      "It comes back unlocked. If it was locked before, lock it again explicitly.",
    ],
    confirmLabel: "Restore the account",
    tone: "primary",
  },
};

/**
 * Inviting an organiser is a privileged action, so it gets the dialog too.
 *
 * PLAN.md lists it as one of the console's three non-negotiable core actions and
 * TODO.md requires "confirmation + reason + immutable audit on **every** action".
 * It was the one that had a reason and an audit row but no confirmation step —
 * a single button that grew the private beta on the first click, with the
 * address only ever checked by the person who typed it.
 *
 * `tone: "primary"` rather than `danger`: nothing is taken away from anybody.
 * The consequence worth reading is that the invitation binds to the **address**,
 * which is what makes a typo a real mistake rather than a retry.
 */
export const ORGANISER_INVITE_COPY: AdminActionCopy = {
  label: "Review invitation",
  title: "Send this host invitation?",
  consequences: [
    "They become a host the first time they sign in with this exact address, verified.",
    "Forwarding the email gets somebody else nothing — the invitation binds to the address, not to the link.",
    "It stays open for fourteen days, and can be re-sent.",
    "Check the address below: an invitation sent to the wrong one cannot be un-sent.",
  ],
  confirmLabel: "Send invitation",
  tone: "primary",
};

export const EVENT_ACTION_COPY: Record<AdminEventAction, AdminActionCopy> = {
  rotateCode: {
    label: "Rotate code",
    title: "Rotate this event's join code?",
    consequences: [
      "The current six digits and QR stop working the moment this commits.",
      "Any sign already printed or photographed is dead.",
    ],
    confirmLabel: "Rotate the code",
    tone: "danger",
  },
  scheduleDeletion: {
    label: "Schedule deletion",
    title: "Schedule this event for deletion?",
    consequences: [
      "The party disappears from everybody's list at once — host, co-hosts and guests.",
      "Thirty days from now the event and everything submitted to it are erased for good.",
      "It is reversible until the purge runs.",
    ],
    confirmLabel: "Schedule deletion",
    tone: "danger",
  },
  restore: {
    label: "Restore",
    title: "Cancel this event's deletion?",
    consequences: [
      "The pending purge job is cancelled and the party comes back in the state it was in.",
      "Its join code is re-checked on the way back — another party may have taken it.",
    ],
    confirmLabel: "Restore the event",
    tone: "primary",
  },
};

/* -------------------------------------------------------------------------- */
/* Which actions a row gets                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read off `accountStateMachine`, in the order a person scans them.
 *
 * `deleted` is terminal and gets nothing — the row is a tombstone. A
 * `deletionScheduled` account is offered `restore` and nothing else: locking one
 * that is already on its way out changes nothing anybody can observe.
 */
export function accountActionsFor(state: AccountState): readonly AdminAccountAction[] {
  const actions: AdminAccountAction[] = [];
  if (state === "deletionScheduled") return ["restore"];
  if (accountStateMachine.canTransition(state, "locked") && state !== "locked")
    actions.push("lock");
  if (state === "locked") actions.push("unlock");
  if (accountStateMachine.canTransition(state, "deletionScheduled")) {
    actions.push("scheduleDeletion");
  }
  return actions;
}

/**
 * The event side.
 *
 * Rotation is offered in every state a code can be rotated in, which
 * `event.rotateInvite`'s gate defines as the editable ones — but this list is
 * about *whether the row shows the control at all*, and an archived party's code
 * is not rotatable, so it is excluded here as well as refused there.
 */
export function eventActionsFor(state: EventState): readonly AdminEventAction[] {
  if (state === "deletionScheduled") return ["restore"];
  const actions: AdminEventAction[] = [];
  if (state !== "archived") actions.push("rotateCode");
  if (eventStateMachine.canTransition(state, "deletionScheduled")) actions.push("scheduleDeletion");
  return actions;
}

/* -------------------------------------------------------------------------- */
/* Row summaries                                                              */
/* -------------------------------------------------------------------------- */

/** The one-line "why is this row like this" a table cell shows under the state. */
export function accountStateNote(account: AdminAccount): string | undefined {
  switch (account.accountState) {
    case "locked":
      return account.lockReason ?? "Locked by an administrator.";
    case "deletionScheduled":
      return "Scheduled for deletion. Access already revoked.";
    case "deleted":
      return "Purged. This row is a tombstone.";
    default:
      return account.isGlobalAdmin
        ? "On the admin allowlist."
        : account.isOrganiser
          ? "Invited host."
          : undefined;
  }
}

/** Whether a row is one the console must not act on. */
export function accountIsActionable(account: AdminAccount): boolean {
  return accountActionsFor(account.accountState).length > 0;
}

/**
 * The event note.
 *
 * `frozen` is not an event state — it is derived from the owner's account — so
 * it has to be said out loud, or an admin looking at a `live` party that answers
 * "suspended" to every guest has no way to tell why.
 */
export function eventStateNote(event: AdminEvent): string | undefined {
  if (event.state === "deletionScheduled") return "Scheduled for deletion.";
  if (event.frozen) return "Frozen — the owner's account is locked or on its way out.";
  if (event.stuckPurges > 0) {
    return `${event.stuckPurges} withdrawn ${event.stuckPurges === 1 ? "item" : "items"} still has files in storage.`;
  }
  return undefined;
}
