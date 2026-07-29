import { AUDIT_ACTIONS, generateOtpCode } from "@partybooth/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  api,
  auditActions,
  clearFakeStorage,
  DEMO_EMAIL,
  DEMO_OTP,
  internal,
  makeTest,
  setDemoLogin,
  setPartialDemoLogin,
  useFakeStorage,
  seedEvent,
  seedMembership,
  seedUser,
} from "./testing.helpers";
import { demoLogin, isDemoAddress, isDemoLogin, resetConfigWarnings } from "./lib/config";
import { demoOtpFor, emailOtpPolicyOptions } from "./lib/otp";
import { mirrorAuthUser } from "./lib/user_mirror";

/**
 * The App Review demo login.
 *
 * One property matters more than all the others and it is the one the whole
 * suite is built around: **with the environment unset, the path is dead.** Not
 * "harder to reach", not "returns an error" — there is no branch from an unset
 * variable to a fixed code, and every assertion below that starts with
 * `setDemoLogin(false)` is checking that the branch is genuinely absent rather
 * than merely guarded.
 *
 * The second property is containment: the reviewer's address behaves specially
 * and **no other address changes at all**. A demo bypass that also loosened the
 * throttle for everybody, or made every code predictable, would be a back door
 * with a marketing name.
 */

const generate = () => emailOtpPolicyOptions().generateOTP;

beforeEach(() => {
  useFakeStorage();
  resetConfigWarnings();
});

afterEach(() => {
  setDemoLogin(false);
  clearFakeStorage();
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

describe("with neither variable set", () => {
  beforeEach(() => setDemoLogin(false));

  it("has no demo account at all", () => {
    expect(demoLogin()).toBeUndefined();
    expect(isDemoAddress(DEMO_EMAIL)).toBe(false);
    expect(isDemoLogin(DEMO_EMAIL, DEMO_OTP)).toBe(false);
  });

  it("gives the reviewer's address a random code like anybody else's", () => {
    expect(demoOtpFor(DEMO_EMAIL)).toBeUndefined();

    const codes = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      codes.add(generate()?.({ email: DEMO_EMAIL, type: "sign-in" }) ?? "");
    }
    // A fixed code would collapse this to one value. This is the assertion that
    // "the path is dead" rather than "the path is guarded".
    expect(codes.size).toBeGreaterThan(1);
  });

  it("refuses to seed a demo party", async () => {
    const t = makeTest();
    await expect(t.mutation(internal.demo.seedDemoEvent, {})).rejects.toThrow(/DEMO_LOGIN_EMAIL/);
  });
});

describe("with only one half set", () => {
  it.each(["email", "otp"] as const)("stays off when only the %s is configured", (half) => {
    setPartialDemoLogin(half);
    // Both or neither. One variable set is a misconfiguration, and it must fail
    // closed rather than half-open.
    expect(demoLogin()).toBeUndefined();
    expect(demoOtpFor(DEMO_EMAIL)).toBeUndefined();
    expect(isDemoLogin(DEMO_EMAIL, DEMO_OTP)).toBe(false);
  });
});

describe("with an invalid code configured", () => {
  it("ignores it rather than taking the deployment down", () => {
    setDemoLogin(true);
    process.env["DEMO_LOGIN_OTP"] = "12";
    // `tolerant` in lib/config: a two-digit code must not stop guests signing in
    // on party night. It fails closed — no demo bypass — and says so in the log.
    expect(demoOtpFor(DEMO_EMAIL)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* With it switched on                                                        */
/* -------------------------------------------------------------------------- */

describe("with both variables set", () => {
  beforeEach(() => setDemoLogin(true));

  it("hands the reviewer's address the fixed code, every time", () => {
    for (let index = 0; index < 10; index += 1) {
      expect(generate()?.({ email: DEMO_EMAIL, type: "sign-in" })).toBe(DEMO_OTP);
    }
  });

  it("matches the address case-insensitively, because a reviewer will type it", () => {
    expect(demoOtpFor(` ${DEMO_EMAIL.toUpperCase()} `)).toBe(DEMO_OTP);
  });

  it("changes nothing for any other address", () => {
    const codes = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      codes.add(generate()?.({ email: "guest@partybooth.test", type: "sign-in" }) ?? "");
    }
    expect(codes.size).toBeGreaterThan(1);
    expect(codes.has(DEMO_OTP)).toBe(false);
    expect(demoOtpFor("guest@partybooth.test")).toBeUndefined();
  });

  it("does not weaken the code policy it rides on", () => {
    const options = emailOtpPolicyOptions();
    // Six digits, ten minutes, five attempts, hashed at rest — the demo account
    // uses the same verification machinery as everyone else, so it inherits all
    // of it. Nothing anywhere compares a submitted code to an env var.
    expect(options.otpLength).toBe(6);
    expect(options.storeOTP).toBe("hashed");
    expect(options.allowedAttempts).toBe(5);
    expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it("rejects the right address with the wrong code", () => {
    expect(isDemoLogin(DEMO_EMAIL, "000000")).toBe(false);
    expect(isDemoLogin(DEMO_EMAIL, DEMO_OTP)).toBe(true);
  });

  it("rejects the right code from the wrong address", () => {
    expect(isDemoLogin("guest@partybooth.test", DEMO_OTP)).toBe(false);
  });

  it("audits every use", async () => {
    const t = makeTest();
    await t.mutation(internal.otp.recordDemoSignIn, { email: DEMO_EMAIL });
    expect(await auditActions(t)).toContain(AUDIT_ACTIONS.demoSignIn);
  });

  it("does not audit a use claimed for another address", async () => {
    const t = makeTest();
    // The audit row asserting a bypass happened must not be forgeable by a
    // caller passing the wrong argument.
    await t.mutation(internal.otp.recordDemoSignIn, { email: "guest@partybooth.test" });
    expect(await auditActions(t)).not.toContain(AUDIT_ACTIONS.demoSignIn);
  });

  it("writes no address and no code into the audit row", async () => {
    const t = makeTest();
    await t.mutation(internal.otp.recordDemoSignIn, { email: DEMO_EMAIL });
    const rows = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    const json = JSON.stringify(rows);
    expect(json).not.toContain(DEMO_EMAIL);
    expect(json).not.toContain(DEMO_OTP);
  });
});

/* -------------------------------------------------------------------------- */
/* The seeded party                                                           */
/* -------------------------------------------------------------------------- */

describe("demo.seedDemoEvent", () => {
  beforeEach(() => setDemoLogin(true));

  it("creates a whole small party the reviewer can actually use", async () => {
    const t = makeTest();
    const result = await t.mutation(internal.demo.seedDemoEvent, { now: 1_800_000_000_000 });

    expect(result.created).toBe(true);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.mediaCount).toBeGreaterThan(0);

    const media = await t.run(async (ctx) => ctx.db.query("media").collect());
    // Something on the wall, something in the queue, something declined — so
    // every screen has content and the moderation queue is not empty.
    expect(media.some((row) => row.state === "approved")).toBe(true);
    expect(media.some((row) => row.state === "pending")).toBe(true);
    expect(media.some((row) => row.state === "declined")).toBe(true);
  });

  it("makes the reviewer the owner and an invited organiser", async () => {
    const t = makeTest();
    const { ownerUserId, eventId } = await t.mutation(internal.demo.seedDemoEvent, {});

    const owner = await t.run(async (ctx) => ctx.db.get(ownerUserId));
    expect(owner?.email).toBe(DEMO_EMAIL);
    expect(owner?.isOrganiser).toBe(true);

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.ownerUserId).toBe(ownerUserId);
    expect(event?.state).toBe("live");
    // `manual`, so the reviewer's first action can be a moderation decision.
    expect(event?.moderationMode).toBe("manual");
  });

  it("gets the counters right, so the pending badge is honest", async () => {
    const t = makeTest();
    const { eventId } = await t.mutation(internal.demo.seedDemoEvent, {});
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    const media = await t.run(async (ctx) => ctx.db.query("media").collect());

    expect(event?.counts.pending).toBe(media.filter((row) => row.state === "pending").length);
    expect(event?.counts.approved).toBe(media.filter((row) => row.state === "approved").length);
    expect(event?.counts.total).toBe(media.length);
  });

  it("is idempotent — a second run does not build a second party", async () => {
    const t = makeTest();
    const first = await t.mutation(internal.demo.seedDemoEvent, {});
    const second = await t.mutation(internal.demo.seedDemoEvent, {});

    expect(second.created).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toHaveLength(1);
    expect(second.mediaCount).toBe(first.mediaCount);
  });

  it("attaches whatever asset keys it is given, in order", async () => {
    const t = makeTest();
    await t.mutation(internal.demo.seedDemoEvent, { assetKeys: ["ut_demo_1", "ut_demo_2"] });

    const media = await t.run(async (ctx) => ctx.db.query("media").collect());
    const keys = media
      .sort((a, b) => a.captureId.localeCompare(b.captureId))
      .map((row) => row.storageKey);
    expect(keys[0]).toBe("ut_demo_1");
    expect(keys[1]).toBe("ut_demo_2");
    // A short list is fine: the remaining rows simply have no thumbnail.
    expect(keys[2]).toBeUndefined();
  });

  it("leaves a demo party a guest can browse", async () => {
    const t = makeTest();
    const { eventId } = await t.mutation(internal.demo.seedDemoEvent, {
      assetKeys: ["ut_demo_1", "ut_demo_2", "ut_demo_3"],
    });

    // The demo fixtures claim the re-encode, so the reviewer signed in as any
    // member sees the gallery rather than an empty grid.
    const seen = await t
      .withIdentity({ subject: "demo-reviewer" })
      .query(api.media.eventMedia, { eventId });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("marks the party as the demo party, which is what confines the identity", async () => {
    const t = makeTest();
    const { eventId } = await t.mutation(internal.demo.seedDemoEvent, {});
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.isDemo).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The reviewer signs in for real                                             */
/* -------------------------------------------------------------------------- */

/**
 * The end-to-end shape the seed exists for, with a **provider-generated** auth
 * id rather than the seed's placeholder.
 *
 * This is the failure the seed used to have: the seeded owner carried
 * `authId: "demo-reviewer"`, Better Auth minted its own id on the reviewer's
 * first sign-in, and the `user.onCreate` trigger inserted a *second* mirror row
 * under that id. The reviewer signed into an account with no membership of the
 * party that had just been built for them — an empty shell, and a rejection for
 * incomplete functionality having done everything right.
 */
describe("the reviewer's first real sign-in", () => {
  beforeEach(() => setDemoLogin(true));

  it("adopts the seeded row instead of creating a second account", async () => {
    const t = makeTest();
    const seeded = await t.mutation(internal.demo.seedDemoEvent, {});

    // What Better Auth actually produces: an opaque, unpredictable id.
    const providerAuthId = "k57f2q8m3n1p4r6s9t0v2w4x";
    const userId = await t.run(async (ctx) =>
      mirrorAuthUser(ctx, {
        authId: providerAuthId,
        email: DEMO_EMAIL,
        emailVerified: true,
        providerName: null,
        now: Date.now(),
      }),
    );

    expect(userId).toEqual(seeded.ownerUserId);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", DEMO_EMAIL))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authId).toBe(providerAuthId);
    // Claimable exactly once.
    expect(rows[0]?.seeded).toBeUndefined();
    // And the deliberate seeded name survives the provider's silence.
    expect(rows[0]?.displayName).toBe("App Review");

    // The point of all of it: the identity the reviewer actually signs in as
    // owns the seeded party.
    const seen = await t
      .withIdentity({ subject: providerAuthId })
      .query(api.media.eventMedia, { eventId: seeded.eventId });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("never adopts an ordinary account that happens to share an address", async () => {
    const t = makeTest();
    const realId = await seedUser(t, { authId: "real-person", email: "sam@partybooth.test" });

    const mirrored = await t.run(async (ctx) =>
      mirrorAuthUser(ctx, {
        authId: "someone-else-entirely",
        email: "sam@partybooth.test",
        emailVerified: true,
        providerName: "Sam",
        now: Date.now(),
      }),
    );

    // Adoption is confined to seeded rows. Matching on address alone would mean
    // any mirror row could be claimed by whoever next signs up with it.
    expect(mirrored).not.toEqual(realId);
  });
});

/* -------------------------------------------------------------------------- */
/* Confinement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The reviewer credential is published, deliberately enabled against the
 * deployment Apple reviews, and on 5 August that is the deployment the real
 * party runs on. "It unlocks a party with no real people in it" was true only
 * for as long as nobody handed it a code — an absence, not a control.
 */
describe("the demo identity is confined to the demo party", () => {
  beforeEach(() => setDemoLogin(true));

  it("cannot read a real party it has been made a member of", async () => {
    const t = makeTest();
    await t.mutation(internal.demo.seedDemoEvent, {});

    const hostId = await seedUser(t, { authId: "host", email: "host@partybooth.test" });
    const realEventId = await seedEvent(t, hostId, { state: "live" });
    const reviewerId = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", DEMO_EMAIL))
            .unique()
        )?._id,
    );
    if (!reviewerId) throw new Error("the seeded reviewer is missing");
    await seedMembership(t, realEventId, reviewerId, "guest");

    // A membership is not enough. The confinement runs before the role is even
    // resolved, and it answers `notFound` like every other event refusal.
    await expect(
      t.withIdentity({ subject: "demo-reviewer" }).query(api.media.eventMedia, {
        eventId: realEventId,
      }),
    ).rejects.toThrow(/could not be found/);
  });

  it("leaves every other account untouched", async () => {
    const t = makeTest();
    const hostId = await seedUser(t, { authId: "host", email: "host@partybooth.test" });
    const realEventId = await seedEvent(t, hostId, { state: "live" });
    await expect(
      t.withIdentity({ subject: "host" }).query(api.media.eventMedia, { eventId: realEventId }),
    ).resolves.toEqual([]);
  });
});
