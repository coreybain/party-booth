import { hasCapability } from "@partybooth/contracts/permissions";
import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_ROLE_CONTEXT,
  canAccessHostTools,
  canManageEvent,
  canModerateMedia,
  canRotateInvite,
  canSubmitMedia,
  type EventRole,
  type RoleContext,
} from "./roles";

function ctx(overrides: Partial<RoleContext> = {}): RoleContext {
  return { ...ANONYMOUS_ROLE_CONTEXT, ...overrides };
}

const EVERY_CHECK = {
  canAccessHostTools,
  canModerateMedia,
  canRotateInvite,
  canManageEvent,
  canSubmitMedia,
} as const;

describe("host tools", () => {
  it("are available to the owner and co-hosts", () => {
    expect(canAccessHostTools(ctx({ eventRole: "owner" }))).toBe(true);
    expect(canAccessHostTools(ctx({ eventRole: "cohost" }))).toBe(true);
  });

  it("are hidden from guests and signed-out users", () => {
    expect(canAccessHostTools(ctx({ eventRole: "guest" }))).toBe(false);
    expect(canAccessHostTools(ctx({ eventRole: null }))).toBe(false);
    expect(canAccessHostTools(ANONYMOUS_ROLE_CONTEXT)).toBe(false);
  });

  it("are not granted to global admins", () => {
    // PLAN.md is explicit: the admin console has "no media access, no impersonation".
    // Admin must not be a backdoor into a party's moderation queue.
    expect(canAccessHostTools(ctx({ accountRole: "globalAdmin", eventRole: null }))).toBe(false);
    expect(canModerateMedia(ctx({ accountRole: "globalAdmin", eventRole: null }))).toBe(false);
  });
});

describe("moderation and invite rotation", () => {
  it("track host access exactly", () => {
    const roles: readonly (EventRole | null)[] = ["owner", "cohost", "guest", null];
    for (const eventRole of roles) {
      const context = ctx({ eventRole });
      expect(canModerateMedia(context)).toBe(canAccessHostTools(context));
      expect(canRotateInvite(context)).toBe(canAccessHostTools(context));
    }
  });
});

describe("canManageEvent", () => {
  it("is owner-only — co-hosts get no delete, transfer or ownership change", () => {
    expect(canManageEvent(ctx({ eventRole: "owner" }))).toBe(true);
    expect(canManageEvent(ctx({ eventRole: "cohost" }))).toBe(false);
    expect(canManageEvent(ctx({ eventRole: "guest" }))).toBe(false);
    expect(canManageEvent(ctx({ eventRole: null }))).toBe(false);
  });
});

describe("canSubmitMedia", () => {
  it("requires a membership in the active event", () => {
    expect(canSubmitMedia(ctx({ eventRole: "guest" }))).toBe(true);
    expect(canSubmitMedia(ctx({ eventRole: "owner" }))).toBe(true);
    expect(canSubmitMedia(ctx({ eventRole: null }))).toBe(false);
  });
});

describe("account lock", () => {
  it("revokes every capability regardless of stored role", () => {
    // TODO.md Sprint 5: "Account lock enforcement: suspends owner/co-host access,
    // joins, uploads, slideshows across owned events".
    for (const eventRole of ["owner", "cohost", "guest"] as const) {
      const locked = ctx({ eventRole, accountLocked: true });
      for (const [name, check] of Object.entries(EVERY_CHECK)) {
        expect(check(locked), `${name} for locked ${eventRole}`).toBe(false);
      }
    }
  });

  it("leaves an explicitly unlocked account alone", () => {
    expect(canAccessHostTools(ctx({ eventRole: "owner", accountLocked: false }))).toBe(true);
  });
});

describe("agreement with @partybooth/contracts", () => {
  // These helpers are an adapter, not a policy. If contracts changes who may moderate
  // or rotate an invite, the mobile shell must move with it — this test fails loudly
  // instead of letting the app drift from what Convex actually enforces.
  const PAIRS = [
    [canModerateMedia, "media.moderate"],
    [canRotateInvite, "event.rotateInvite"],
    [canManageEvent, "event.delete"],
    [canSubmitMedia, "media.upload"],
    [canAccessHostTools, "media.viewPending"],
  ] as const;

  it("mirrors the contracts capability matrix for every event role", () => {
    for (const eventRole of ["owner", "cohost", "guest"] as const) {
      for (const [check, action] of PAIRS) {
        expect(check(ctx({ eventRole })), `${action} for ${eventRole}`).toBe(
          hasCapability(eventRole, action),
        );
      }
    }
  });
});
