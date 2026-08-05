import { describe, expect, it } from "vitest";

import { guestInitials, sortGuests } from "@/lib/guest-activity";
import type { GuestMember } from "@/lib/convex-api";

function guest(overrides: Partial<GuestMember> = {}): GuestMember {
  return {
    membershipId: "membership-1",
    userId: "user-1",
    displayName: "Ada Lovelace",
    joinedAt: 1,
    autoApproveMedia: false,
    submissionCount: 0,
    approvedCount: 0,
    ...overrides,
  };
}

describe("guest activity ordering", () => {
  const guests = [
    guest({ userId: "quiet-new", displayName: "New Guest", joinedAt: 30 }),
    guest({ userId: "active-old", displayName: "Active Guest", joinedAt: 10, submissionCount: 8 }),
    guest({ userId: "active-new", displayName: "Also Active", joinedAt: 20, submissionCount: 8 }),
  ];

  it("puts the newest arrivals first without mutating the live query result", () => {
    const result = sortGuests(guests, "recent");
    expect(result.map((person) => person.userId)).toEqual([
      "quiet-new",
      "active-new",
      "active-old",
    ]);
    expect(guests.map((person) => person.userId)).toEqual([
      "quiet-new",
      "active-old",
      "active-new",
    ]);
  });

  it("ranks upload activity first and recency as the useful tie-breaker", () => {
    expect(sortGuests(guests, "active").map((person) => person.userId)).toEqual([
      "active-new",
      "active-old",
      "quiet-new",
    ]);
  });
});

describe("guest initials", () => {
  it("uses the first and last words", () => {
    expect(guestInitials("Mary Jane Watson")).toBe("MW");
  });

  it("has a fallback for an empty or anonymised label", () => {
    expect(guestInitials("  ")).toBe("?");
    expect(guestInitials("Former guest")).toBe("FG");
  });
});
