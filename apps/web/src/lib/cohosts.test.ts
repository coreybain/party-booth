import { describe, expect, it } from "vitest";

import {
  checkCohostEmail,
  COHOST_POWERS,
  cohostPanelMode,
  hostRoster,
  invitationExpiryLabel,
} from "@/lib/cohosts";
import type { CohostInvitation, CohostList, CohostMember } from "@/lib/convex-api";

function member(overrides: Partial<CohostMember> = {}): CohostMember {
  return {
    membershipId: "m1",
    userId: "u1",
    displayName: "Ada",
    role: "guest",
    status: "active",
    joinedAt: 1,
    ...overrides,
  };
}

function invitation(overrides: Partial<CohostInvitation> = {}): CohostInvitation {
  return {
    id: "i1",
    email: "grace@example.test",
    status: "pending",
    expiresAt: 1_000,
    createdAt: 1,
    ...overrides,
  };
}

function list(overrides: Partial<CohostList> = {}): CohostList {
  return { members: [], invitations: [], canInvite: true, ...overrides };
}

describe("who gets the manage view of the co-host panel", () => {
  it("takes the answer from the server rather than comparing roles", () => {
    // `canInvite` is computed in `cohosts.list` from the same predicate the
    // mutation enforces. Deciding it here would be a second copy of the
    // permission matrix, and the way that fails is a button that does nothing.
    expect(cohostPanelMode(list({ canInvite: true }))).toBe("manage");
    expect(cohostPanelMode(list({ canInvite: false }))).toBe("readOnly");
  });

  it("splits the roster the way the panel renders it", () => {
    const roster = hostRoster([
      member({ userId: "u1", role: "owner" }),
      member({ userId: "u2", role: "cohost" }),
      member({ userId: "u3", role: "guest" }),
      member({ userId: "u4", role: "guest" }),
    ]);
    expect(roster.owner?.userId).toBe("u1");
    expect(roster.cohosts.map((c) => c.userId)).toEqual(["u2"]);
    expect(roster.guestCount).toBe(2);
  });

  it("copes with a roster that has no owner row", () => {
    // An owner has a membership, but a co-host's list is filtered to actives and
    // the panel must not throw on a party mid-transfer.
    expect(hostRoster([member({ role: "cohost" })]).owner).toBeUndefined();
  });

  it("writes down both halves of what a co-host may do", () => {
    // Sprint 5 moved settings editing *into* the co-host set (PLAN.md risk #4's
    // pressure valve) and host-list management *out* of it. Both directions have
    // to be visible to the person reading the panel.
    expect(COHOST_POWERS.can.join(" ")).toMatch(/moderation mode/i);
    expect(COHOST_POWERS.cannot.join(" ")).toMatch(/another co-host/i);
    expect(COHOST_POWERS.cannot.join(" ")).toMatch(/transfer ownership/i);
  });
});

describe("validating an address before it costs a round trip", () => {
  it("accepts and normalises a real one", () => {
    expect(checkCohostEmail("  Grace@Example.Test ")).toEqual({
      ok: true,
      email: "grace@example.test",
    });
  });

  it("refuses nonsense with the contract's own message", () => {
    const result = checkCohostEmail("not-an-address");
    expect(result.ok).toBe(false);
  });

  it("refuses the host inviting themselves", () => {
    const result = checkCohostEmail("ada@example.test", { ownEmail: "Ada@Example.test" });
    expect(result).toEqual({ ok: false, error: "You are already the host of this party." });
  });

  it("refuses a duplicate of an invitation already on screen", () => {
    const result = checkCohostEmail("grace@example.test", {
      existing: [invitation({ status: "pending" })],
    });
    expect(result.ok).toBe(false);
  });

  it("allows re-inviting an address whose invitation was revoked", () => {
    const result = checkCohostEmail("grace@example.test", {
      existing: [invitation({ status: "revoked" })],
    });
    expect(result.ok).toBe(true);
  });
});

describe("what a pending invitation says about itself", () => {
  const now = 1_700_000_000_000;

  it("counts down in the unit that is useful at that distance", () => {
    expect(invitationExpiryLabel(now + 14 * 86_400_000, now)).toBe("Expires in 14 days");
    expect(invitationExpiryLabel(now + 86_400_000, now)).toBe("Expires in 1 day");
    expect(invitationExpiryLabel(now + 3 * 3_600_000, now)).toBe("Expires in 3 hours");
    expect(invitationExpiryLabel(now + 60_000, now)).toBe("Expires within the hour");
  });

  it("says plainly when the link is dead, because that is the actionable case", () => {
    expect(invitationExpiryLabel(now, now)).toBe("Expired — send it again");
    expect(invitationExpiryLabel(now - 1, now)).toBe("Expired — send it again");
  });
});
