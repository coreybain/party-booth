import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/contracts";
import {
  ACCOUNT_ACTION_COPY,
  accountActionsFor,
  accountStateNote,
  EVENT_ACTION_COPY,
  eventActionsFor,
  eventStateNote,
} from "@/lib/admin/actions";
import {
  auditActionGroup,
  auditActionLabel,
  auditRowIsSuspect,
  DEFAULT_AUDIT_FILTERS,
  filterAuditRows,
} from "@/lib/admin/audit-view";
import { checkReason, confirmEnabled, reasonMessage } from "@/lib/admin/reason-gate";
import type { AdminAccount, AdminEvent, AuditRow } from "@/lib/convex-api";

/* -------------------------------------------------------------------------- */
/* The reason gate                                                            */
/* -------------------------------------------------------------------------- */

describe("no privileged action without a typed reason", () => {
  it("keeps confirm dead for an empty or too-short reason", () => {
    expect(confirmEnabled(checkReason(""), false)).toBe(false);
    expect(confirmEnabled(checkReason("   "), false)).toBe(false);
    expect(confirmEnabled(checkReason("ab"), false)).toBe(false);
    // Whitespace is not a reason: the schema trims before it counts.
    expect(confirmEnabled(checkReason("  a  "), false)).toBe(false);
  });

  it("enables it once the reason would survive `adminReasonSchema`", () => {
    const gate = checkReason("  Spam reports from three guests.  ");
    expect(gate.ok).toBe(true);
    expect(gate.trimmed).toBe("Spam reports from three guests.");
    expect(confirmEnabled(gate, false)).toBe(true);
  });

  it("stays dead while the mutation is in flight, however good the reason", () => {
    expect(confirmEnabled(checkReason("Locked at the owner's request."), true)).toBe(false);
  });

  it("refuses a reason past the ceiling and counts down to it", () => {
    const long = "x".repeat(281);
    const gate = checkReason(long);
    expect(gate.ok).toBe(false);
    expect(gate.remaining).toBe(-1);
    expect(checkReason("x".repeat(280)).ok).toBe(true);
  });

  it("does not shout at an untouched or still-empty field", () => {
    expect(reasonMessage(checkReason(""), false)).toBeUndefined();
    expect(reasonMessage(checkReason(""), true)).toBeUndefined();
    expect(reasonMessage(checkReason("ab"), true)).toBeTypeOf("string");
  });
});

/* -------------------------------------------------------------------------- */
/* Row actions                                                                */
/* -------------------------------------------------------------------------- */

function account(overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: "u1",
    email: "ada@example.test",
    displayName: "Ada",
    accountState: "active",
    isOrganiser: true,
    isGlobalAdmin: false,
    emailVerified: true,
    ownedEvents: 2,
    memberships: 3,
    storageBytes: 1_024,
    mediaCount: 4,
    pushDevices: 1,
    createdAt: 1,
    ...overrides,
  };
}

function event(overrides: Partial<AdminEvent> = {}): AdminEvent {
  return {
    id: "e1",
    name: "Ada's party",
    state: "live",
    ownerUserId: "u1",
    ownerDisplayName: "Ada",
    frozen: false,
    counts: { pending: 1, approved: 2, declined: 0, total: 3 },
    processing: 0,
    assetCount: 3,
    storageBytes: 2_048,
    memberCount: 12,
    stuckPurges: 0,
    startsAt: 10,
    createdAt: 1,
    ...overrides,
  };
}

describe("which actions an accounts row is offered", () => {
  it("offers lock and deletion for an active account, and never unlock", () => {
    expect(accountActionsFor("active")).toEqual(["lock", "scheduleDeletion"]);
  });

  it("offers unlock rather than lock for a locked one", () => {
    expect(accountActionsFor("locked")).toEqual(["unlock", "scheduleDeletion"]);
  });

  it("offers only restore to an account on its way out", () => {
    // Locking one that is already being deleted changes nothing observable, so
    // the row does not pretend it is a choice.
    expect(accountActionsFor("deletionScheduled")).toEqual(["restore"]);
  });

  it("offers nothing at all on a tombstone", () => {
    expect(accountActionsFor("deleted")).toEqual([]);
  });

  it("has confirmation copy for every action it can offer", () => {
    for (const state of ["active", "locked", "deletionScheduled", "deleted"] as const) {
      for (const action of accountActionsFor(state)) {
        const copy = ACCOUNT_ACTION_COPY[action];
        expect(copy.consequences.length).toBeGreaterThan(0);
        expect(copy.confirmLabel.length).toBeGreaterThan(0);
      }
    }
  });

  it("says the lock freezes the party, not merely the person", () => {
    // The Sprint 5 finding, in the one sentence an admin reads before pressing.
    expect(ACCOUNT_ACTION_COPY.lock.consequences.join(" ")).toMatch(/party they own freezes/i);
  });

  it("surfaces the lock reason, and never invents one", () => {
    expect(accountStateNote(account({ accountState: "locked", lockReason: "Abuse." }))).toBe(
      "Abuse.",
    );
    expect(accountStateNote(account({ accountState: "locked" }))).toMatch(/administrator/i);
    expect(accountStateNote(account())).toMatch(/organiser/i);
    expect(accountStateNote(account({ isOrganiser: false }))).toBeUndefined();
  });
});

describe("which actions an events row is offered", () => {
  it("offers rotation and deletion for a running party", () => {
    expect(eventActionsFor("live")).toEqual(["rotateCode", "scheduleDeletion"]);
  });

  it("does not offer to rotate the code of an archived party", () => {
    expect(eventActionsFor("archived")).toEqual(["scheduleDeletion"]);
  });

  it("offers only restore to one already queued for deletion", () => {
    expect(eventActionsFor("deletionScheduled")).toEqual(["restore"]);
  });

  it("has confirmation copy for every action it can offer", () => {
    for (const state of ["draft", "scheduled", "live", "paused", "archived"] as const) {
      for (const action of eventActionsFor(state)) {
        expect(EVENT_ACTION_COPY[action].consequences.length).toBeGreaterThan(0);
      }
    }
  });

  it("explains a freeze, which is not an event state and has no badge", () => {
    expect(eventStateNote(event({ frozen: true }))).toMatch(/owner's account/i);
    expect(eventStateNote(event({ stuckPurges: 1 }))).toMatch(/1 withdrawn item/);
    expect(eventStateNote(event({ stuckPurges: 3 }))).toMatch(/3 withdrawn items/);
    expect(eventStateNote(event())).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The audit viewer                                                           */
/* -------------------------------------------------------------------------- */

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "a1",
    action: AUDIT_ACTIONS.accountLocked,
    subjectType: "user",
    actorDisplayName: "Grace",
    actorRole: "globalAdmin",
    reason: "Repeated reports.",
    createdAt: 100,
    ...overrides,
  };
}

describe("the audit log viewer", () => {
  it("turns an action name into a sentence without a lookup table to maintain", () => {
    expect(auditActionLabel(AUDIT_ACTIONS.inviteRotated)).toBe("Invite rotated");
    expect(auditActionLabel(AUDIT_ACTIONS.accountDeletionScheduled)).toBe("Deletion scheduled");
    expect(auditActionGroup(AUDIT_ACTIONS.inviteRotated)).toBe("event");
  });

  it("still renders a row written by a version of the product that no longer exists", () => {
    expect(auditActionLabel("legacy.thing_that_happened")).toBe("Thing that happened");
    expect(auditActionLabel("bare")).toBe("Bare");
  });

  it("flags a reason-requiring row that somehow arrived without one", () => {
    expect(auditRowIsSuspect(row({ reason: undefined }))).toBe(true);
    expect(auditRowIsSuspect(row({ reason: "   " }))).toBe(true);
    expect(auditRowIsSuspect(row())).toBe(false);
    // A row whose action never needed one is not suspect.
    expect(auditRowIsSuspect(row({ action: AUDIT_ACTIONS.joinSucceeded, reason: undefined }))).toBe(
      false,
    );
  });

  it("filters by group, by free text and by whether a reason is present", () => {
    const rows = [
      row({ id: "a1", action: AUDIT_ACTIONS.accountLocked, reason: "Spam." }),
      row({ id: "a2", action: AUDIT_ACTIONS.inviteRotated, reason: "Sign walked off." }),
      row({ id: "a3", action: AUDIT_ACTIONS.joinSucceeded, reason: undefined }),
    ];

    expect(filterAuditRows(rows, DEFAULT_AUDIT_FILTERS)).toHaveLength(3);
    expect(
      filterAuditRows(rows, { ...DEFAULT_AUDIT_FILTERS, group: "account" }).map((r) => r.id),
    ).toEqual(["a1"]);
    expect(
      filterAuditRows(rows, { ...DEFAULT_AUDIT_FILTERS, search: "walked" }).map((r) => r.id),
    ).toEqual(["a2"]);
    expect(
      filterAuditRows(rows, { ...DEFAULT_AUDIT_FILTERS, withReasonOnly: true }).map((r) => r.id),
    ).toEqual(["a1", "a2"]);
  });

  it("searches the rendered label, not only the raw action name", () => {
    const rows = [row({ action: AUDIT_ACTIONS.inviteRotated })];
    // Nobody types `invite_rotated`.
    expect(
      filterAuditRows(rows, { ...DEFAULT_AUDIT_FILTERS, search: "invite rotated" }),
    ).toHaveLength(1);
  });
});
