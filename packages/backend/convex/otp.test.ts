import { OTP_POLICY } from "@partybooth/contracts";
import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReference, SchemaDefinition } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

type T = TestConvex<SchemaDefinition<typeof schema.tables, true>>;

const modules = import.meta.glob("./**/*.*s");

/** Same cast as `auth.ts`: `_generated/api.d.ts` is the generic fallback. */
const registerSend = (internal.otp as unknown as Record<string, unknown>)[
  "registerSend"
] as FunctionReference<
  "mutation",
  "internal",
  { email: string; now?: number },
  { allowed: boolean; reason?: "cooldown" | "rateLimited"; retryAfterMs: number }
>;

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

describe("otp.registerSend", () => {
  let t: T;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  const send = (email: string, now: number) => t.mutation(registerSend, { email, now });

  it("allows the first send and records the state", async () => {
    expect(await send("guest@partybooth.test", T0)).toEqual({ allowed: true, retryAfterMs: 0 });

    const rows = await t.run(async (ctx) => ctx.db.query("otpChallenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "guest@partybooth.test",
      lastSentAt: T0,
      sendCount: 1,
      windowStartedAt: T0,
    });
  });

  it("enforces the fifteen-second cooldown independently of Better Auth", async () => {
    await send("guest@partybooth.test", T0);

    const blocked = await send("guest@partybooth.test", T0 + 5_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("cooldown");
    expect(blocked.retryAfterMs).toBe(10_000);

    expect((await send("guest@partybooth.test", T0 + OTP_POLICY.resendCooldownMs)).allowed).toBe(
      true,
    );
  });

  it("does not extend the cooldown when it refuses", async () => {
    await send("guest@partybooth.test", T0);
    await send("guest@partybooth.test", T0 + 5_000);
    await send("guest@partybooth.test", T0 + 10_000);
    // A client retrying in a loop must still get through on the boundary.
    expect((await send("guest@partybooth.test", T0 + OTP_POLICY.resendCooldownMs)).allowed).toBe(
      true,
    );
  });

  it("caps sends per address per hour, however patient the caller is", async () => {
    let now = T0;
    for (let i = 0; i < OTP_POLICY.maxSendsPerWindow; i += 1) {
      expect((await send("victim@partybooth.test", now)).allowed, `send #${i + 1}`).toBe(true);
      now += 2 * MINUTE;
    }

    const blocked = await send("victim@partybooth.test", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("rateLimited");

    // A fresh window opens an hour after the first send, not after the last.
    expect((await send("victim@partybooth.test", T0 + OTP_POLICY.sendWindowMs)).allowed).toBe(true);
  });

  it("keys on the normalised address, so casing and spaces are not a way around it", async () => {
    await send("Guest@PartyBooth.test", T0);
    const blocked = await send("  guest@partybooth.test  ", T0 + 1000);
    expect(blocked.allowed).toBe(false);

    const rows = await t.run(async (ctx) => ctx.db.query("otpChallenges").collect());
    expect(rows).toHaveLength(1);
  });

  it("throttles each address independently", async () => {
    await send("a@partybooth.test", T0);
    expect((await send("b@partybooth.test", T0)).allowed).toBe(true);
  });

  it("answers identically for an address with an account and one without", async () => {
    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: "auth_1",
        email: "real@partybooth.test",
        emailVerified: true,
        displayName: "Real",
        accountState: "active",
        isOrganiser: false,
        isGlobalAdmin: false,
        createdAt: T0,
        updatedAt: T0,
      }),
    );

    const known = await send("real@partybooth.test", T0);
    const unknown = await send("invented@partybooth.test", T0);
    expect(known).toEqual(unknown);

    const knownBlocked = await send("real@partybooth.test", T0 + 1000);
    const unknownBlocked = await send("invented@partybooth.test", T0 + 1000);
    expect(knownBlocked).toEqual(unknownBlocked);
  });
});
