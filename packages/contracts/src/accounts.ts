import { z } from "zod";

import { createStateMachine, type TransitionTable } from "./state-machine";

/**
 * Account lifecycle.
 *
 * - `active` — normal.
 * - `locked` — suspended by a global admin. Per PLAN.md this freezes owner and
 *   co-host access, joins, uploads and slideshows across every event the
 *   account owns. The account can still sign in to see that it is locked and to
 *   request deletion (Apple requires in-app deletion to stay reachable).
 * - `deletionScheduled` — the user (or an admin) asked for deletion. Access is
 *   revoked immediately; the 30-day purge job itself is post-launch (P1), so at
 *   launch this state is entered and honoured but nothing physically deletes.
 * - `deleted` — purged. Terminal.
 */
export const ACCOUNT_STATES = ["active", "locked", "deletionScheduled", "deleted"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

export const accountStateSchema = z.enum(ACCOUNT_STATES);

const ACCOUNT_TRANSITIONS: TransitionTable<AccountState> = {
  active: ["locked", "deletionScheduled"],
  // An admin may unlock, or the user may ask to be deleted while locked.
  locked: ["active", "deletionScheduled"],
  // Restore-from-deletion returns to `active`; a locked account that asked for
  // deletion is restored unlocked, and re-locking is one extra explicit action.
  deletionScheduled: ["active", "deleted"],
  deleted: [],
};

export const accountStateMachine = createStateMachine(
  "Account",
  ACCOUNT_STATES,
  ACCOUNT_TRANSITIONS,
);

/** The only state in which an account has full product access. */
export const ACTIVE_ACCOUNT_STATES = ["active"] as const satisfies readonly AccountState[];

export function isAccountActive(state: AccountState): boolean {
  return state === "active";
}

/**
 * Whether the account may still authenticate at all. Locked and
 * deletion-scheduled accounts can sign in — they need to see *why* they are
 * blocked, and Apple requires the in-app deletion path to remain reachable.
 */
export function canAccountSignIn(state: AccountState): boolean {
  return state !== "deleted";
}
