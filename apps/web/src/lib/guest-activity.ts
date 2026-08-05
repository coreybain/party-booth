import type { GuestMember } from "@/lib/convex-api";

export type GuestActivityView = "recent" | "active";

/**
 * One roster, two useful host views. Keep the sort outside the component so
 * the dashboard and future mobile console cannot quietly disagree about what
 * "most active" means.
 */
export function sortGuests(guests: readonly GuestMember[], view: GuestActivityView): GuestMember[] {
  return [...guests].sort((left, right) => {
    if (view === "active") {
      const byUploads = right.submissionCount - left.submissionCount;
      if (byUploads !== 0) return byUploads;

      const byApproved = right.approvedCount - left.approvedCount;
      if (byApproved !== 0) return byApproved;
    }

    const byJoinedAt = right.joinedAt - left.joinedAt;
    if (byJoinedAt !== 0) return byJoinedAt;
    return left.displayName.localeCompare(right.displayName);
  });
}

/** Up to two human-looking initials, with a safe fallback for deleted users. */
export function guestInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}
