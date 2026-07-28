import { toAppErrorView } from "@/lib/app-errors";
import type { AccountState } from "@/lib/contracts";

/**
 * What a locked account sees, and what everybody else sees about it.
 *
 * The two halves of this file must never converge, and that is the whole reason
 * it exists:
 *
 * - **The account itself is told everything.** A lock is appealable only if the
 *   person can find out that they are locked, and Apple requires the in-app
 *   deletion path to stay reachable regardless. So `/account/locked` says the
 *   word, says what it means for their parties, and offers the two things they
 *   can still do — sign out, and delete the account.
 * - **Guests are told nothing about a third party's standing with us.** A
 *   suspended host's party has thirty people in the room; telling them "the
 *   organiser's account is suspended" is a fact about somebody else, broadcast.
 *   `convex/lib/lock.ts` already answers those surfaces with one deliberately
 *   vague sentence, and {@link unavailableEventView} makes sure the *framing*
 *   around it does not reintroduce the leak — "ask the host for a new code" is
 *   both wrong and pointed when the code is fine.
 */

/* -------------------------------------------------------------------------- */
/* The organiser's own screen                                                 */
/* -------------------------------------------------------------------------- */

/** Why the organiser console refused. Everything but `ok` renders a screen. */
export type OrganiserAccess =
  "ok" | "signedOut" | "locked" | "deletionScheduled" | "deleted" | "needsInvitation";

export interface OrganiserAccessInput {
  readonly accountState: AccountState;
  readonly isOrganiser: boolean;
  readonly isGlobalAdmin: boolean;
  /**
   * Whether this account owns or co-hosts at least one party.
   *
   * A co-host is **not** an organiser: accepting a co-host invitation does not
   * set `isOrganiser`, and it must not — that flag gates *creating* events and
   * the private beta is invitation-only. But a co-host who cannot open
   * `/media` cannot moderate, which is the entire point of RC5, so hosting
   * something is its own way in. This is the fix for it.
   */
  readonly hostsAnEvent: boolean;
}

/**
 * The gate, as a value rather than a redirect.
 *
 * Account state is checked **first**, before the invitation. A locked organiser
 * failing the `isOrganiser` branch would be told to go and get invited, which is
 * both untrue and a dead end — and, before this existed, an infinite redirect
 * loop between `/` and `/dashboard`.
 */
export function organiserAccess(user: OrganiserAccessInput | null): OrganiserAccess {
  if (user === null) return "signedOut";

  switch (user.accountState) {
    case "locked":
      return "locked";
    case "deletionScheduled":
      return "deletionScheduled";
    case "deleted":
      return "deleted";
    case "active":
      break;
  }

  if (user.isGlobalAdmin || user.isOrganiser || user.hostsAnEvent) return "ok";
  return "needsInvitation";
}

export interface BlockedAccountCopy {
  readonly title: string;
  readonly body: string;
  /** The second paragraph: what happens to the parties they run. */
  readonly effect: string;
  /** Whether "Delete my account" is offered. Apple 5.1.1(v) says yes, always. */
  readonly offerDeletion: boolean;
}

/**
 * The locked screen's words.
 *
 * Deliberately specific — this is the one audience entitled to the detail — and
 * deliberately not apologetic: an admin locked this account for a reason that is
 * in the audit log, and pretending it was a glitch wastes everybody's time.
 */
export const BLOCKED_ACCOUNT_COPY: Record<
  Exclude<OrganiserAccess, "ok" | "signedOut" | "needsInvitation">,
  BlockedAccountCopy
> = {
  locked: {
    title: "This account is suspended",
    body: "An administrator has suspended your PartyBooth account. Reply to the email we sent you, or contact whoever invited you, and we will look at it.",
    effect:
      "Every party you host is paused while this lasts: co-hosts cannot moderate, guests cannot upload, and nobody new can join — including from a printed QR code. Nothing has been deleted, and it all comes back if the suspension is lifted.",
    offerDeletion: true,
  },
  deletionScheduled: {
    title: "This account is being deleted",
    body: "Your account is scheduled for deletion, so access has already stopped. Thirty days after it was scheduled, the account and everything you uploaded are erased for good.",
    effect:
      "The parties you host are closed. Photos you submitted to other people's parties stay there until the purge runs, with your name removed. If this was a mistake, get in touch before the thirty days are up — it can still be undone.",
    offerDeletion: false,
  },
  deleted: {
    title: "This account no longer exists",
    body: "This account has been deleted. There is nothing left to sign in to.",
    effect: "If you want to use PartyBooth again you will need a fresh invitation.",
    offerDeletion: false,
  },
};

/* -------------------------------------------------------------------------- */
/* What a guest sees                                                          */
/* -------------------------------------------------------------------------- */

export interface UnavailableEventView {
  readonly title: string;
  readonly body: string;
  /** Whether to offer "join with a code" — pointless when the code is not the problem. */
  readonly offerRejoin: boolean;
  readonly signedOut: boolean;
}

/**
 * Turn a failing `events.home` into a screen, without leaking why.
 *
 * Three cases, and the middle one is the one this function exists for:
 *
 * - `unauthenticated` / `accountDeleted` → the session is gone. Say so; sign in.
 * - **`forbidden`** → the party is frozen because of its owner's account state.
 *   The backend's message is already written for this audience and says nothing
 *   about whose account it is (`EVENT_FREEZE_MESSAGES` in `convex/lib/lock.ts`),
 *   so it is shown **verbatim** — and the "ask the host for the current QR"
 *   advice is dropped, because a fresh code would not help and the suggestion
 *   points a room full of guests at a host who cannot fix it.
 * - anything else, in practice `notFound` → a membership that is gone or a
 *   credential that is superseded, which a new code genuinely does fix.
 */
export function unavailableEventView(error: unknown): UnavailableEventView {
  const view = toAppErrorView(error);

  if (view.code === "unauthenticated" || view.code === "accountDeleted") {
    return {
      title: "You've been signed out",
      body: "Sign in again with the code from the sign.",
      offerRejoin: true,
      signedOut: true,
    };
  }

  if (view.code === "forbidden" || view.code === "accountLocked") {
    return {
      title: "This party isn't available right now",
      body: view.message,
      offerRejoin: false,
      signedOut: false,
    };
  }

  return {
    title: "This event isn't open to you",
    body: `${view.message} The host may have issued a new code — ask them to show you the current QR.`,
    offerRejoin: true,
    signedOut: false,
  };
}
