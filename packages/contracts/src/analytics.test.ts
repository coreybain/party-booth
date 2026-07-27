import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENTS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  auditActionRequiresReason,
  isAnalyticsEventName,
  isAuditAction,
} from "./analytics";

describe("analytics event names", () => {
  it("has no duplicates", () => {
    expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(ANALYTICS_EVENT_NAMES.length);
  });

  it("uses snake_case throughout", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(name, `${name} should be snake_case`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("recognises its own names and nothing else", () => {
    expect(isAnalyticsEventName(ANALYTICS_EVENTS.mediaUploaded)).toBe(true);
    expect(isAnalyticsEventName("media.uploaded")).toBe(false);
    expect(isAnalyticsEventName(42)).toBe(false);
  });
});

describe("audit actions", () => {
  it("has no duplicates", () => {
    expect(new Set(AUDIT_ACTION_NAMES).size).toBe(AUDIT_ACTION_NAMES.length);
  });

  it("uses `entity.action` naming, distinct from the analytics namespace", () => {
    for (const action of AUDIT_ACTION_NAMES) {
      expect(action, `${action} should look like entity.action`).toMatch(
        /^[a-z]+\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
      );
      expect(ANALYTICS_EVENT_NAMES).not.toContain(action);
    }
  });

  it("requires a reason for every destructive admin action", () => {
    expect(auditActionRequiresReason(AUDIT_ACTIONS.accountLocked)).toBe(true);
    expect(auditActionRequiresReason(AUDIT_ACTIONS.eventDeleted)).toBe(true);
    expect(auditActionRequiresReason(AUDIT_ACTIONS.membershipRevoked)).toBe(true);
    expect(auditActionRequiresReason(AUDIT_ACTIONS.accountDeletionScheduled)).toBe(true);
  });

  it("does not demand a reason for routine, user-initiated actions", () => {
    expect(auditActionRequiresReason(AUDIT_ACTIONS.eventCreated)).toBe(false);
    expect(auditActionRequiresReason(AUDIT_ACTIONS.membershipCreated)).toBe(false);
    expect(auditActionRequiresReason(AUDIT_ACTIONS.mediaModerated)).toBe(false);
  });

  it("recognises its own actions and nothing else", () => {
    expect(isAuditAction(AUDIT_ACTIONS.accountLocked)).toBe(true);
    expect(isAuditAction("account_locked")).toBe(false);
  });
});
