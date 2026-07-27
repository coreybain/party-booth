import { ACCOUNT_STATES, EVENT_STATES } from "@partybooth/contracts";
import { describe, expect, it } from "vitest";

import {
  AUDIT_SUBJECTS,
  DELETION_JOB_STATES,
  INVITE_VERSION_STATUSES,
  literalUnion,
  MEMBERSHIP_STATUSES,
  ORGANISER_INVITATION_STATUSES,
  storageRegion,
} from "./validators";

type LiteralLike = { kind: string; value?: string; members?: { value: string }[] };

describe("literalUnion", () => {
  it("builds a union from a contract enum", () => {
    const validator = literalUnion(EVENT_STATES) as unknown as LiteralLike;
    expect(validator.kind).toBe("union");
    expect(validator.members?.map((m) => m.value)).toEqual([...EVENT_STATES]);
  });

  it("collapses a one-value enum to a plain literal", () => {
    // Convex's `v.union` needs two members; the single-region beta would
    // otherwise be unrepresentable.
    const validator = storageRegion as unknown as LiteralLike;
    expect(validator.kind).toBe("literal");
    expect(validator.value).toBe("pdx1");
  });

  it("refuses an empty enum instead of producing an unusable validator", () => {
    expect(() => literalUnion([])).toThrow(/at least one/i);
  });

  it("preserves declaration order, which the schema tests assert against", () => {
    const validator = literalUnion(ACCOUNT_STATES) as unknown as LiteralLike;
    expect(validator.members?.map((m) => m.value)).toEqual([
      "active",
      "locked",
      "deletionScheduled",
      "deleted",
    ]);
  });
});

describe("schema-local enums", () => {
  it.each([
    ["memberships", MEMBERSHIP_STATUSES],
    ["inviteVersions", INVITE_VERSION_STATUSES],
    ["organiserInvitations", ORGANISER_INVITATION_STATUSES],
    ["deletionJobs", DELETION_JOB_STATES],
    ["auditEvents", AUDIT_SUBJECTS],
  ])("%s has unique, non-empty values", (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value).not.toBe("");
  });

  it("keeps membership and invite-version lifecycles distinct from event states", () => {
    // A membership is not an event; sharing the vocabulary would invite a
    // `status === state` bug that only shows up after a rotation.
    for (const status of MEMBERSHIP_STATUSES) {
      expect(EVENT_STATES as readonly string[]).not.toContain(status);
    }
  });

  it("has exactly one active invite-version status", () => {
    expect(INVITE_VERSION_STATUSES).toEqual(["active", "revoked"]);
  });

  it("can express a scheduled deletion that was cancelled before it ran", () => {
    expect(DELETION_JOB_STATES).toContain("scheduled");
    expect(DELETION_JOB_STATES).toContain("cancelled");
  });
});
