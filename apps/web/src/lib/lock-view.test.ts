import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { BLOCKED_ACCOUNT_COPY, organiserAccess, unavailableEventView } from "@/lib/lock-view";

function appError(code: string, message: string): unknown {
  return new ConvexError({ code, message });
}

describe("who may open the organiser console", () => {
  const active = { accountState: "active", isOrganiser: true, isGlobalAdmin: false } as const;

  it("lets an invited organiser in", () => {
    expect(organiserAccess({ ...active, hostsAnEvent: false })).toBe("ok");
  });

  it("lets a co-host in even though co-hosting never sets `isOrganiser`", () => {
    // RC5 is "a second account as co-host moderates from their phone". Before
    // this, that account was bounced out of the console entirely: accepting a
    // co-host invitation grants a membership and nothing else.
    expect(
      organiserAccess({
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: false,
        hostsAnEvent: true,
      }),
    ).toBe("ok");
  });

  it("keeps a plain guest out", () => {
    expect(
      organiserAccess({
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: false,
        hostsAnEvent: false,
      }),
    ).toBe("needsInvitation");
  });

  it("reports a locked account as locked rather than as uninvited", () => {
    // Getting this wrong sent a locked organiser to "you need an invitation",
    // which is untrue, unactionable, and — since `/` bounces a signed-in user to
    // `/dashboard` — an infinite redirect.
    expect(organiserAccess({ ...active, accountState: "locked", hostsAnEvent: true })).toBe(
      "locked",
    );
    expect(
      organiserAccess({ ...active, accountState: "deletionScheduled", hostsAnEvent: true }),
    ).toBe("deletionScheduled");
    expect(organiserAccess({ ...active, accountState: "deleted", hostsAnEvent: true })).toBe(
      "deleted",
    );
  });

  it("checks the account state before the allowlist, admins included", () => {
    expect(
      organiserAccess({
        accountState: "locked",
        isOrganiser: false,
        isGlobalAdmin: true,
        hostsAnEvent: false,
      }),
    ).toBe("locked");
  });

  it("treats no session as signed out", () => {
    expect(organiserAccess(null)).toBe("signedOut");
  });

  it("still offers account deletion to a locked account", () => {
    // Apple 5.1.1(v): in-app deletion has to stay reachable. A lock is also only
    // appealable if the person can see that they are locked.
    expect(BLOCKED_ACCOUNT_COPY.locked.offerDeletion).toBe(true);
    expect(BLOCKED_ACCOUNT_COPY.locked.title).toMatch(/suspended/i);
    expect(BLOCKED_ACCOUNT_COPY.locked.effect).toMatch(/nothing has been deleted/i);
  });
});

describe("what a guest is told when a party is frozen", () => {
  it("shows the backend's neutral sentence and drops the 'get a new code' advice", () => {
    const view = unavailableEventView(
      appError("forbidden", "This event is suspended. Ask the organiser to get in touch with us."),
    );
    expect(view.title).toBe("This party isn't available right now");
    expect(view.body).toBe("This event is suspended. Ask the organiser to get in touch with us.");
    // A fresh code would not help, and pointing thirty guests at a host who
    // cannot fix it is how a suspension becomes a scene.
    expect(view.offerRejoin).toBe(false);
    expect(view.body).not.toMatch(/QR/);
  });

  it("never names the account state, the owner or the word 'locked'", () => {
    const view = unavailableEventView(
      appError("forbidden", "This event is closed — the organiser's account is being removed."),
    );
    expect(view.title).not.toMatch(/lock/i);
    expect(view.title).not.toMatch(/suspend/i);
  });

  it("does offer a fresh code when a fresh code is the actual fix", () => {
    const view = unavailableEventView(appError("notFound", "That event isn't available."));
    expect(view.offerRejoin).toBe(true);
    expect(view.body).toMatch(/current QR/);
  });

  it("routes a dead session to sign-in instead", () => {
    const view = unavailableEventView(appError("unauthenticated", "Sign in to continue."));
    expect(view.signedOut).toBe(true);
    expect(view.title).toBe("You've been signed out");
  });

  it("falls back to something a guest can read for a non-Convex failure", () => {
    const view = unavailableEventView(new TypeError("boom"));
    expect(view.title).toBe("This event isn't open to you");
    expect(view.body.length).toBeGreaterThan(0);
  });
});
