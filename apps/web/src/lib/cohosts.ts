import { emailSchema } from "@/lib/contracts";
import type { CohostInvitation, CohostList, CohostMember } from "@/lib/convex-api";

/**
 * The co-host panel's rules, without a component around them.
 *
 * The one that matters is {@link cohostPanelMode}. `cohosts.list` answers with
 * `canInvite`, computed server-side from the same predicate `createInvitation`
 * enforces — owner, and an active account. The panel reads *that* rather than
 * comparing roles itself, so a co-host's read-only view and the mutation's
 * refusal are one decision made in one place. A panel that decided for itself
 * would be a second copy of the permission matrix, and the way that fails is a
 * button that exists and does not work.
 */

export type CohostPanelMode = "manage" | "readOnly";

export function cohostPanelMode(list: CohostList): CohostPanelMode {
  return list.canInvite ? "manage" : "readOnly";
}

/** Who is in, split the way the panel renders them. */
export interface HostRoster {
  readonly owner?: CohostMember;
  readonly cohosts: readonly CohostMember[];
  readonly guestCount: number;
}

export function hostRoster(members: readonly CohostMember[]): HostRoster {
  const owner = members.find((member) => member.role === "owner");
  return {
    ...(owner === undefined ? {} : { owner }),
    cohosts: members.filter((member) => member.role === "cohost"),
    guestCount: members.filter((member) => member.role === "guest").length,
  };
}

/* -------------------------------------------------------------------------- */
/* The invite form                                                            */
/* -------------------------------------------------------------------------- */

export type CohostEmailRejection =
  { readonly ok: true; readonly email: string } | { readonly ok: false; readonly error: string };

/**
 * Validate a typed address before it costs a round trip.
 *
 * `emailSchema` is the contract's, so the form and `inviteCohostInputSchema`
 * agree. The two extra checks are the ones a host actually trips over — inviting
 * themselves, and re-inviting somebody already sitting in the list above the
 * form — and both would otherwise come back as a `ConvexError` several seconds
 * later with the field already cleared.
 */
export function checkCohostEmail(
  raw: string,
  context: { readonly ownEmail?: string; readonly existing?: readonly CohostInvitation[] } = {},
): CohostEmailRejection {
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That is not an email address." };
  }
  const email = parsed.data;

  if (context.ownEmail !== undefined && email === context.ownEmail.trim().toLowerCase()) {
    return { ok: false, error: "You are already the host of this party." };
  }

  const pending = (context.existing ?? []).some(
    (invitation) => invitation.status === "pending" && invitation.email === email,
  );
  if (pending) {
    return { ok: false, error: "They have already been invited. Re-sending is below." };
  }

  return { ok: true, email };
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "Expires in 6 days" / "Expired".
 *
 * A pending invitation with a date on it is the difference between "they have
 * not got round to it" and "that link is dead and needs sending again", which is
 * the only question a host asks about this list.
 */
export function invitationExpiryLabel(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired — send it again";

  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) return `Expires in ${days} ${days === 1 ? "day" : "days"}`;

  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 1) return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;

  return "Expires within the hour";
}

/**
 * What a co-host can and cannot do, for the panel a co-host reads.
 *
 * Straight off the capability matrix in `@partybooth/contracts/permissions`, and
 * worth writing out because "co-host" is the one role whose boundaries somebody
 * has to be told rather than discover. The Sprint 5 change — settings editing in,
 * host-list management out — is why the first list mentions the moderation
 * switch by name.
 */
export const COHOST_POWERS = {
  can: [
    "Approve, decline and take down submissions",
    "Open, pause and close the party, and switch the moderation mode",
    "Edit the schedule and the event's settings",
    "Show the join code and QR, and rotate them",
    "Run the slideshow",
  ],
  cannot: [
    "Invite or remove another co-host",
    "Archive or delete the party",
    "Transfer ownership",
    "Permanently delete somebody else's photograph — declining is as far as it goes",
  ],
} as const;
