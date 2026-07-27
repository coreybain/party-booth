import { describe, expect, it } from "vitest";

import { ACCOUNT_STATES, type AccountState } from "./accounts";
import { EVENT_STATES, type EventState } from "./events";
import { MEDIA_STATES } from "./media";
import {
  ACTION_RESOURCE_KIND,
  ACTIONS,
  accountStateAllows,
  can,
  canAct,
  capabilitiesOf,
  explainCan,
  hasCapability,
  type Action,
  type Resource,
} from "./permissions";
import { ROLES, type Role } from "./roles";

/* -------------------------------------------------------------------------- */
/* The exhaustive capability matrix                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every action, and exactly which roles hold it. `Record<Action, …>` means a
 * new action fails to compile until it is listed here, so this table cannot
 * silently fall behind `permissions.ts`.
 *
 * Read the empty rows carefully — they are the deliberate ones.
 */
const EXPECTED_CAPABILITIES: Record<Action, readonly Role[]> = {
  // -- Platform ------------------------------------------------------------
  "platform.createEvent": ["owner", "cohost", "guest"],
  "platform.inviteOrganiser": ["globalAdmin"],
  "platform.viewAdminConsole": ["globalAdmin"],
  "platform.viewAccounts": ["globalAdmin"],
  "platform.viewAuditLog": ["globalAdmin"],
  // Nobody sees guests' media from the admin console. Not even the admin.
  "platform.viewMedia": [],
  // Nobody impersonates anybody, ever.
  "platform.impersonateUser": [],

  // -- Events --------------------------------------------------------------
  "event.view": ["globalAdmin", "owner", "cohost", "guest"],
  "event.update": ["owner"],
  "event.updateSchedule": ["owner", "cohost"],
  "event.changeModerationMode": ["owner"],
  "event.changeState": ["globalAdmin", "owner"],
  "event.archive": ["globalAdmin", "owner"],
  "event.delete": ["owner"],
  "event.transferOwnership": ["owner"],
  "event.viewInviteCode": ["globalAdmin", "owner", "cohost"],
  "event.rotateInvite": ["globalAdmin", "owner", "cohost"],
  "event.presentSlideshow": ["owner", "cohost"],
  "event.viewStats": ["globalAdmin", "owner", "cohost"],
  "event.join": ["guest"],

  // -- Memberships ---------------------------------------------------------
  "membership.list": ["globalAdmin", "owner", "cohost"],
  "membership.inviteCohost": ["owner"],
  "membership.revoke": ["globalAdmin", "owner", "cohost"],
  "membership.leave": ["cohost", "guest"],

  // -- Media ---------------------------------------------------------------
  "media.upload": ["owner", "cohost", "guest"],
  "media.viewOwn": ["owner", "cohost", "guest"],
  "media.viewApproved": ["owner", "cohost", "guest"],
  "media.viewPending": ["owner", "cohost"],
  "media.moderate": ["owner", "cohost"],
  "media.withdrawOwn": ["owner", "cohost", "guest"],
  "media.delete": ["owner"],
  "media.report": ["owner", "cohost", "guest"],

  // -- Accounts ------------------------------------------------------------
  "account.view": ["globalAdmin", "owner", "cohost", "guest"],
  "account.updateProfile": ["owner", "cohost", "guest"],
  "account.requestDeletion": ["owner", "cohost", "guest"],
  "account.registerPushDevice": ["owner", "cohost", "guest"],
  "account.lock": ["globalAdmin"],
  "account.unlock": ["globalAdmin"],
  "account.scheduleDeletion": ["globalAdmin"],
  "account.restoreDeletion": ["globalAdmin"],
};

describe("capability matrix", () => {
  it("covers every declared action exactly once", () => {
    expect(Object.keys(EXPECTED_CAPABILITIES).sort()).toEqual([...ACTIONS].sort());
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  it.each(ACTIONS)("grants %s to exactly the expected roles", (action) => {
    const expected = EXPECTED_CAPABILITIES[action];
    for (const role of ROLES) {
      expect(
        hasCapability(role, action),
        `${role} → ${action} should be ${expected.includes(role)}`,
      ).toBe(expected.includes(role));
    }
  });

  it("keeps globalAdmin away from every media action", () => {
    const mediaActions = ACTIONS.filter((action) => action.startsWith("media."));
    expect(mediaActions.length).toBeGreaterThan(0);
    for (const action of mediaActions) {
      expect(hasCapability("globalAdmin", action)).toBe(false);
    }
  });

  it("denies the forbidden platform actions to every role", () => {
    for (const role of ROLES) {
      expect(hasCapability(role, "platform.viewMedia")).toBe(false);
      expect(hasCapability(role, "platform.impersonateUser")).toBe(false);
    }
  });

  it("gives cohosts strictly fewer capabilities than owners, minus event.join", () => {
    const owner = new Set(capabilitiesOf("owner"));
    const cohostOnly = capabilitiesOf("cohost").filter((action) => !owner.has(action));
    // An owner never needs to leave their own event; that is the one asymmetry.
    expect(cohostOnly).toEqual(["membership.leave"]);
  });

  it("never lets a cohost change ownership or destroy the event", () => {
    for (const action of ["event.delete", "event.transferOwnership", "event.update"] as const) {
      expect(hasCapability("cohost", action)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const liveEvent = (state: EventState = "live") => ({ kind: "event", state }) as const;

const ownMedia = (eventState: EventState = "live") =>
  ({ kind: "media", state: "approved", isOwn: true, event: { state: eventState } }) as const;

/* -------------------------------------------------------------------------- */
/* Event gates                                                                 */
/* -------------------------------------------------------------------------- */

describe("can() — event gates", () => {
  it("only lets guests join scheduled, live or paused events", () => {
    const joinable: EventState[] = ["scheduled", "live", "paused"];
    for (const state of EVENT_STATES) {
      expect(can("guest", "event.join", liveEvent(state))).toBe(joinable.includes(state));
    }
  });

  it("refuses settings edits once the event is archived or scheduled for deletion", () => {
    expect(can("owner", "event.update", liveEvent("live"))).toBe(true);
    expect(can("owner", "event.update", liveEvent("draft"))).toBe(true);
    expect(can("owner", "event.update", liveEvent("archived"))).toBe(false);
    expect(can("owner", "event.update", liveEvent("deletionScheduled"))).toBe(false);
  });

  it("refuses invite rotation on a dead event", () => {
    expect(can("cohost", "event.rotateInvite", liveEvent("live"))).toBe(true);
    expect(can("cohost", "event.rotateInvite", liveEvent("archived"))).toBe(false);
  });

  it("still presents the slideshow for an archived event", () => {
    expect(can("owner", "event.presentSlideshow", liveEvent("archived"))).toBe(true);
    expect(can("owner", "event.presentSlideshow", liveEvent("draft"))).toBe(false);
  });

  it("will not archive something already archived or deleted", () => {
    expect(can("owner", "event.archive", liveEvent("live"))).toBe(true);
    expect(can("owner", "event.archive", liveEvent("archived"))).toBe(false);
    expect(can("owner", "event.archive", liveEvent("deletionScheduled"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Membership gates                                                            */
/* -------------------------------------------------------------------------- */

describe("can() — membership gates", () => {
  const membership = (over: Partial<Extract<Resource, { kind: "membership" }>> = {}) =>
    ({
      kind: "membership",
      targetRole: "guest",
      isSelf: false,
      event: { state: "live" },
      ...over,
    }) as Extract<Resource, { kind: "membership" }>;

  it("never revokes an owner's membership", () => {
    expect(can("owner", "membership.revoke", membership({ targetRole: "cohost" }))).toBe(true);
    expect(can("owner", "membership.revoke", membership({ targetRole: "owner" }))).toBe(false);
    expect(can("globalAdmin", "membership.revoke", membership({ targetRole: "owner" }))).toBe(
      false,
    );
  });

  it("never lets someone revoke themselves", () => {
    expect(can("owner", "membership.revoke", membership({ isSelf: true }))).toBe(false);
    expect(can("cohost", "membership.revoke", membership({ isSelf: true }))).toBe(false);
  });

  it("lets a co-host revoke a guest, but never the owner", () => {
    // docs/domain-model.md grants this, and PLAN.md risk #4 (solo moderation)
    // is why: a co-host who can decline photos but not remove the person
    // posting them is not much help at 1am.
    expect(can("cohost", "membership.revoke", membership({ targetRole: "guest" }))).toBe(true);
    expect(can("cohost", "membership.revoke", membership({ targetRole: "owner" }))).toBe(false);
  });

  it("lets guests and cohosts leave, but only their own membership", () => {
    expect(
      can("guest", "membership.leave", membership({ isSelf: true, targetRole: "guest" })),
    ).toBe(true);
    expect(
      can("guest", "membership.leave", membership({ isSelf: false, targetRole: "guest" })),
    ).toBe(false);
    expect(
      can("cohost", "membership.leave", membership({ isSelf: true, targetRole: "cohost" })),
    ).toBe(true);
  });

  it("does not let an owner walk out on their own party", () => {
    expect(
      can("owner", "membership.leave", membership({ isSelf: true, targetRole: "owner" })),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Media gates                                                                 */
/* -------------------------------------------------------------------------- */

describe("can() — media gates", () => {
  const media = (over: Partial<Extract<Resource, { kind: "media" }>> = {}) =>
    ({
      kind: "media",
      state: "pending",
      isOwn: false,
      event: { state: "live" },
      ...over,
    }) as Extract<Resource, { kind: "media" }>;

  it("only accepts uploads while the event is live", () => {
    for (const state of EVENT_STATES) {
      expect(can("guest", "media.upload", media({ state: "processing", event: { state } }))).toBe(
        state === "live",
      );
    }
  });

  it("treats deleted media as non-existent for every action", () => {
    for (const role of ROLES) {
      for (const action of [
        "media.viewOwn",
        "media.viewApproved",
        "media.viewPending",
        "media.moderate",
        "media.withdrawOwn",
        "media.delete",
        "media.report",
      ] as const) {
        expect(can(role, action, media({ state: "deleted", isOwn: true }))).toBe(false);
      }
    }
  });

  it("shows approved media only while the event is viewable", () => {
    expect(
      can("guest", "media.viewApproved", media({ state: "approved", event: { state: "live" } })),
    ).toBe(true);
    expect(
      can(
        "guest",
        "media.viewApproved",
        media({ state: "approved", event: { state: "archived" } }),
      ),
    ).toBe(true);
    expect(
      can("guest", "media.viewApproved", media({ state: "pending", event: { state: "live" } })),
    ).toBe(false);
    expect(
      can(
        "guest",
        "media.viewApproved",
        media({ state: "approved", event: { state: "scheduled" } }),
      ),
    ).toBe(false);
  });

  it("lets a guest see and withdraw only their own submission", () => {
    expect(can("guest", "media.viewOwn", media({ isOwn: true }))).toBe(true);
    expect(can("guest", "media.viewOwn", media({ isOwn: false }))).toBe(false);
    expect(can("guest", "media.withdrawOwn", media({ isOwn: true }))).toBe(true);
    expect(can("guest", "media.withdrawOwn", media({ isOwn: false }))).toBe(false);
  });

  it("never lets a guest see the pending queue", () => {
    expect(can("guest", "media.viewPending", media({ state: "pending" }))).toBe(false);
    expect(can("cohost", "media.viewPending", media({ state: "pending" }))).toBe(true);
  });

  it("does not moderate media that is still processing", () => {
    for (const state of MEDIA_STATES) {
      const allowed = state !== "processing" && state !== "deleted";
      expect(can("owner", "media.moderate", media({ state }))).toBe(allowed);
    }
  });

  it("only lets an owner hard-delete someone else's media", () => {
    expect(can("owner", "media.delete", media())).toBe(true);
    expect(can("cohost", "media.delete", media())).toBe(false);
  });

  it("does not let you report your own upload", () => {
    expect(can("guest", "media.report", media({ isOwn: false }))).toBe(true);
    expect(can("guest", "media.report", media({ isOwn: true }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Account gates                                                               */
/* -------------------------------------------------------------------------- */

describe("can() — account gates", () => {
  const account = (state: AccountState, isSelf: boolean) =>
    ({ kind: "account", state, isSelf }) as const;

  it("lets an admin view anyone but a user only themselves", () => {
    expect(can("globalAdmin", "account.view", account("active", false))).toBe(true);
    expect(can("guest", "account.view", account("active", false))).toBe(false);
    expect(can("guest", "account.view", account("active", true))).toBe(true);
  });

  it("will not let an admin lock themselves out", () => {
    expect(can("globalAdmin", "account.lock", account("active", false))).toBe(true);
    expect(can("globalAdmin", "account.lock", account("active", true))).toBe(false);
  });

  it("only unlocks accounts that are locked", () => {
    expect(can("globalAdmin", "account.unlock", account("locked", false))).toBe(true);
    expect(can("globalAdmin", "account.unlock", account("active", false))).toBe(false);
  });

  it("keeps in-app deletion reachable for a locked account (App Review requirement)", () => {
    expect(can("guest", "account.requestDeletion", account("locked", true))).toBe(true);
    expect(
      canAct(
        { role: "guest", accountState: "locked" },
        "account.requestDeletion",
        account("locked", true),
      ),
    ).toBe(true);
  });

  it("refuses every action on a deleted account", () => {
    expect(can("globalAdmin", "account.view", account("deleted", false))).toBe(false);
    expect(can("guest", "account.updateProfile", account("deleted", true))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Platform gate                                                               */
/* -------------------------------------------------------------------------- */

describe("can() — platform gate", () => {
  it("only lets invited organisers create events (private beta)", () => {
    expect(can("guest", "platform.createEvent", { kind: "platform", isOrganiser: true })).toBe(
      true,
    );
    expect(can("guest", "platform.createEvent", { kind: "platform", isOrganiser: false })).toBe(
      false,
    );
  });

  it("does not give a global admin event creation", () => {
    expect(
      can("globalAdmin", "platform.createEvent", { kind: "platform", isOrganiser: true }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Account-state gate                                                          */
/* -------------------------------------------------------------------------- */

describe("accountStateAllows", () => {
  it("permits everything for an active account", () => {
    for (const action of ACTIONS) {
      expect(accountStateAllows("active", action)).toBe(true);
    }
  });

  it("freezes a locked account down to viewing itself and asking for deletion", () => {
    const allowed = ACTIONS.filter((action) => accountStateAllows("locked", action));
    expect(allowed).toEqual(["account.view", "account.requestDeletion"]);
  });

  it("freezes a deletion-scheduled account down to viewing itself", () => {
    const allowed = ACTIONS.filter((action) => accountStateAllows("deletionScheduled", action));
    expect(allowed).toEqual(["account.view"]);
  });

  it("permits nothing for a deleted account", () => {
    for (const action of ACTIONS) {
      expect(accountStateAllows("deleted", action)).toBe(false);
    }
  });

  it("blocks a locked owner from uploading or moderating", () => {
    expect(canAct({ role: "owner", accountState: "locked" }, "media.moderate", ownMedia())).toBe(
      false,
    );
    expect(canAct({ role: "owner", accountState: "active" }, "media.moderate", ownMedia())).toBe(
      true,
    );
  });

  it("covers every account state", () => {
    for (const state of ACCOUNT_STATES) {
      expect(typeof accountStateAllows(state, "event.view")).toBe("boolean");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* explainCan                                                                  */
/* -------------------------------------------------------------------------- */

describe("explainCan", () => {
  it("reports the account gate first", () => {
    expect(
      explainCan({ role: "owner", accountState: "locked" }, "media.moderate", ownMedia()),
    ).toEqual({ allowed: false, reason: "accountNotActive" });
  });

  it("reports a missing capability", () => {
    expect(
      explainCan({ role: "guest", accountState: "active" }, "media.moderate", ownMedia()),
    ).toEqual({ allowed: false, reason: "roleLacksCapability" });
  });

  it("reports a resource-state denial", () => {
    expect(
      explainCan({ role: "owner", accountState: "active" }, "event.update", liveEvent("archived")),
    ).toEqual({ allowed: false, reason: "resourceState" });
  });

  it("agrees with canAct on every action for every role", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const resource = sampleResource(action);
        const actor = { role, accountState: "active" as const };
        expect(explainCan(actor, action, resource as never).allowed).toBe(
          canAct(actor, action, resource as never),
        );
      }
    }
  });

  it("catches a resource of the wrong kind at runtime", () => {
    // Only reachable from untyped call sites (a Convex arg, a JSON body).
    expect(
      explainCan({ role: "owner", accountState: "active" }, "event.update", {
        kind: "platform",
        isOrganiser: true,
      } as never),
    ).toEqual({ allowed: false, reason: "resourceMismatch" });
  });
});

/** A permissive resource of the right shape for any action. */
function sampleResource(action: Action): Resource {
  switch (ACTION_RESOURCE_KIND[action]) {
    case "platform":
      return { kind: "platform", isOrganiser: true };
    case "event":
      return { kind: "event", state: "live" };
    case "membership":
      return {
        kind: "membership",
        targetRole: "guest",
        isSelf: action === "membership.leave",
        event: { state: "live" },
      };
    case "media":
      return {
        kind: "media",
        state: action === "media.upload" ? "processing" : "approved",
        isOwn: action !== "media.report",
        event: { state: "live" },
      };
    case "account":
      return {
        kind: "account",
        state: action === "account.unlock" ? "locked" : "active",
        isSelf: !action.startsWith("account.lock") && !action.startsWith("account.schedule"),
      };
  }
}
