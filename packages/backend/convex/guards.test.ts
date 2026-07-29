import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  checkPermission,
  getCurrentUser,
  requireActiveUser,
  requireEventActor,
  requireEventRole,
  requireGlobalAdmin,
  requirePermission,
  requireUser,
  toPermissionActor,
} from "./lib/guards";

type T = TestConvex<SchemaDefinition<typeof schema.tables, true>>;

/**
 * convex-test finds the function modules by looking for a `_generated`
 * directory. The workspace uses Bun's hoisted node_modules at the repo root,
 * so its "sibling to node_modules" heuristic does not fire — the module map is
 * passed explicitly instead. This is also why the convex-test suites sit at the
 * root of `convex/` rather than beside the code they exercise.
 */
const modules = import.meta.glob("./**/*.*s");

function makeTest(): T {
  return convexTest(schema, modules);
}

const ADMIN_EMAIL = "admin@partybooth.test";

/**
 * The admin allowlist comes from the environment, and `@partybooth/env`
 * memoises each variable the first time it is read — so the cache has to be
 * dropped alongside the value.
 */
function setAllowlist(value: string | undefined): void {
  if (value === undefined) {
    delete process.env["ADMIN_EMAIL_ALLOWLIST"];
  } else {
    process.env["ADMIN_EMAIL_ALLOWLIST"] = value;
  }
  resetEnvCache(serverEnv);
}

afterEach(() => {
  setAllowlist(undefined);
});

async function seedUser(
  t: T,
  over: Partial<Doc<"users">> & { authId: string; email: string },
): Promise<Id<"users">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: over.authId,
      email: over.email,
      emailVerified: over.emailVerified ?? true,
      displayName: over.displayName ?? "Test User",
      accountState: over.accountState ?? "active",
      isOrganiser: over.isOrganiser ?? false,
      isGlobalAdmin: over.isGlobalAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedEvent(
  t: T,
  ownerUserId: Id<"users">,
  over: Partial<Doc<"events">> = {},
): Promise<Id<"events">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("events", {
      ownerUserId,
      name: over.name ?? "Test party",
      state: over.state ?? "live",
      moderationMode: over.moderationMode ?? "manual",
      storageRegion: "pdx1",
      startsAt: now,
      timeZone: "Europe/London",
      allowLibraryImport: true,
      counts: { pending: 0, approved: 0, declined: 0, total: 0 },
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedMembership(
  t: T,
  eventId: Id<"events">,
  userId: Id<"users">,
  role: Doc<"memberships">["role"],
  status: Doc<"memberships">["status"] = "active",
): Promise<Id<"memberships">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("memberships", { eventId, userId, role, status, joinedAt: Date.now() }),
  );
}

describe("getCurrentUser / requireUser", () => {
  let t: T;

  beforeEach(() => {
    t = makeTest();
  });

  it("returns null when nobody is signed in", async () => {
    expect(await t.run(async (ctx) => getCurrentUser(ctx))).toBeNull();
  });

  it("returns null for an identity with no mirrored user row", async () => {
    // Better Auth created a session but the mirroring trigger has not run.
    const as = t.withIdentity({ subject: "auth_unknown" });
    expect(await as.run(async (ctx) => getCurrentUser(ctx))).toBeNull();
  });

  it("resolves the app user from the Better Auth subject", async () => {
    await seedUser(t, { authId: "auth_1", email: "guest@partybooth.test" });
    const as = t.withIdentity({ subject: "auth_1" });
    const user = await as.run(async (ctx) => getCurrentUser(ctx));
    expect(user?.email).toBe("guest@partybooth.test");
  });

  it("throws `unauthenticated` rather than returning null", async () => {
    await expect(t.run(async (ctx) => requireUser(ctx))).rejects.toThrow(/Sign in/i);
  });
});

describe("requireActiveUser", () => {
  let t: T;

  beforeEach(() => {
    t = makeTest();
  });

  it("lets an active account through", async () => {
    await seedUser(t, { authId: "auth_1", email: "a@partybooth.test" });
    const as = t.withIdentity({ subject: "auth_1" });
    await expect(as.run(async (ctx) => requireActiveUser(ctx))).resolves.toBeDefined();
  });

  it.each(["locked", "deletionScheduled", "deleted"] as const)(
    "refuses a %s account",
    async (state) => {
      await seedUser(t, { authId: "auth_1", email: "a@partybooth.test", accountState: state });
      const as = t.withIdentity({ subject: "auth_1" });
      await expect(as.run(async (ctx) => requireActiveUser(ctx))).rejects.toThrow();
    },
  );

  it("tells a locked user why, without saying it to anyone else", async () => {
    await seedUser(t, { authId: "auth_1", email: "a@partybooth.test", accountState: "locked" });
    const as = t.withIdentity({ subject: "auth_1" });
    await expect(as.run(async (ctx) => requireActiveUser(ctx))).rejects.toThrow(/suspended/i);
  });
});

describe("requireGlobalAdmin", () => {
  let t: T;

  beforeEach(() => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
  });

  it("admits an allowlisted address", async () => {
    await seedUser(t, { authId: "auth_admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "auth_admin" });
    await expect(as.run(async (ctx) => requireGlobalAdmin(ctx))).resolves.toBeDefined();
  });

  it("refuses someone who is not on the list", async () => {
    await seedUser(t, { authId: "auth_1", email: "nobody@partybooth.test" });
    const as = t.withIdentity({ subject: "auth_1" });
    await expect(as.run(async (ctx) => requireGlobalAdmin(ctx))).rejects.toThrow();
  });

  it("ignores a forged isGlobalAdmin column — the allowlist is the authority", async () => {
    await seedUser(t, {
      authId: "auth_forged",
      email: "attacker@partybooth.test",
      isGlobalAdmin: true,
    });
    const as = t.withIdentity({ subject: "auth_forged" });
    await expect(as.run(async (ctx) => requireGlobalAdmin(ctx))).rejects.toThrow();
  });

  it("fails closed when the allowlist is unset", async () => {
    setAllowlist(undefined);
    await seedUser(t, { authId: "auth_admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "auth_admin" });
    await expect(as.run(async (ctx) => requireGlobalAdmin(ctx))).rejects.toThrow();
  });

  it("refuses a locked admin", async () => {
    await seedUser(t, { authId: "auth_admin", email: ADMIN_EMAIL, accountState: "locked" });
    const as = t.withIdentity({ subject: "auth_admin" });
    await expect(as.run(async (ctx) => requireGlobalAdmin(ctx))).rejects.toThrow();
  });
});

describe("requireEventActor", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    ownerId = await seedUser(t, { authId: "auth_owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId);
  });

  it("gives the creator the owner role", async () => {
    const as = t.withIdentity({ subject: "auth_owner" });
    const actor = await as.run(async (ctx) => requireEventActor(ctx, eventId));
    expect(actor.role).toBe("owner");
  });

  it("gives a member the role on their membership", async () => {
    const cohostId = await seedUser(t, { authId: "auth_cohost", email: "co@partybooth.test" });
    await seedMembership(t, eventId, cohostId, "cohost");
    const as = t.withIdentity({ subject: "auth_cohost" });
    expect((await as.run(async (ctx) => requireEventActor(ctx, eventId))).role).toBe("cohost");
  });

  it("gives a global admin the globalAdmin role without a membership", async () => {
    await seedUser(t, { authId: "auth_admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "auth_admin" });
    const actor = await as.run(async (ctx) => requireEventActor(ctx, eventId));
    expect(actor.role).toBe("globalAdmin");
    expect(actor.membership).toBeNull();
  });

  it("lets ownership win over admin, so a host keeps host powers", async () => {
    // Corey is on the admin allowlist and also throws the party.
    const bothId = await seedUser(t, { authId: "auth_both", email: ADMIN_EMAIL });
    const ownEventId = await seedEvent(t, bothId);
    const as = t.withIdentity({ subject: "auth_both" });
    expect((await as.run(async (ctx) => requireEventActor(ctx, ownEventId))).role).toBe("owner");
  });

  it("hides the event from a stranger behind `notFound`, not `forbidden`", async () => {
    await seedUser(t, { authId: "auth_stranger", email: "who@partybooth.test" });
    const as = t.withIdentity({ subject: "auth_stranger" });
    // Same error as a nonexistent id, so ids cannot be enumerated.
    await expect(as.run(async (ctx) => requireEventActor(ctx, eventId))).rejects.toThrow(
      /could not be found/i,
    );
  });

  it("treats a revoked membership as no membership", async () => {
    const exGuestId = await seedUser(t, { authId: "auth_ex", email: "ex@partybooth.test" });
    await seedMembership(t, eventId, exGuestId, "guest", "revoked");
    const as = t.withIdentity({ subject: "auth_ex" });
    await expect(as.run(async (ctx) => requireEventActor(ctx, eventId))).rejects.toThrow(
      /could not be found/i,
    );
  });
});

describe("requireEventRole", () => {
  let t: T;
  let ownerId: Id<"users">;
  let eventId: Id<"events">;

  beforeEach(async () => {
    t = makeTest();
    setAllowlist(ADMIN_EMAIL);
    ownerId = await seedUser(t, { authId: "auth_owner", email: "owner@partybooth.test" });
    eventId = await seedEvent(t, ownerId);
  });

  it("accepts a role at or above the minimum", async () => {
    const as = t.withIdentity({ subject: "auth_owner" });
    await expect(
      as.run(async (ctx) => requireEventRole(ctx, eventId, "cohost")),
    ).resolves.toBeDefined();
    await expect(
      as.run(async (ctx) => requireEventRole(ctx, eventId, "owner")),
    ).resolves.toBeDefined();
  });

  it("refuses a role below the minimum", async () => {
    const guestId = await seedUser(t, { authId: "auth_guest", email: "g@partybooth.test" });
    await seedMembership(t, eventId, guestId, "guest");
    const as = t.withIdentity({ subject: "auth_guest" });
    await expect(as.run(async (ctx) => requireEventRole(ctx, eventId, "cohost"))).rejects.toThrow();
  });

  it("does not let a global admin borrow host powers", async () => {
    // Admins manage the platform; they never moderate someone else's party.
    await seedUser(t, { authId: "auth_admin", email: ADMIN_EMAIL });
    const as = t.withIdentity({ subject: "auth_admin" });
    await expect(as.run(async (ctx) => requireEventRole(ctx, eventId, "cohost"))).rejects.toThrow();
  });
});

describe("requirePermission", () => {
  const active = { role: "cohost", accountState: "active" } as const;

  it("passes an allowed action", () => {
    expect(() =>
      requirePermission(active, "media.moderate", {
        kind: "media",
        state: "pending",
        isOwn: false,
        event: { state: "live" },
      }),
    ).not.toThrow();
  });

  it("throws a ConvexError with the contract's message", () => {
    expect(() =>
      requirePermission(active, "event.delete", { kind: "event", state: "live" }),
    ).toThrow(/permission/i);
  });

  it("blocks a locked actor before it even looks at the role", () => {
    expect(() =>
      requirePermission({ role: "owner", accountState: "locked" }, "media.moderate", {
        kind: "media",
        state: "pending",
        isOwn: false,
        event: { state: "live" },
      }),
    ).toThrow(/suspended|deletion/i);
  });

  it("has a non-throwing twin for rendering decisions", () => {
    expect(checkPermission(active, "event.delete", { kind: "event", state: "live" })).toBe(false);
    expect(
      checkPermission(active, "event.presentSlideshow", { kind: "event", state: "live" }),
    ).toBe(true);
  });

  it("builds an actor from a user row", () => {
    const user = { accountState: "active" } as Doc<"users">;
    expect(toPermissionActor(user, "owner")).toEqual({ role: "owner", accountState: "active" });
  });
});
