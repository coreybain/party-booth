import { describe, expect, it } from "vitest";

import {
  accountJoinKey,
  canAttemptJoin,
  JOIN_POLICY,
  JOIN_REJECTED_MESSAGE,
  JOIN_REJECTION_REASONS,
  joinInputSchema,
  joinRejected,
  joinResultSchema,
  parseJoinResult,
  joinThrottled,
  networkJoinKey,
  registerJoinFailure,
  registerJoinSuccess,
  type JoinAttemptState,
  type JoinResult,
} from "./join";

const T0 = 1_700_000_000_000;

/** Drive `n` consecutive failures from a clean slate, one second apart. */
function failTimes(n: number, start = T0): JoinAttemptState | undefined {
  let state: JoinAttemptState | undefined;
  for (let i = 0; i < n; i += 1) {
    state = registerJoinFailure(state, start + i * 1000);
  }
  return state;
}

describe("throttle keys", () => {
  it("namespaces account and network keys so they cannot collide", () => {
    expect(accountJoinKey("abc")).toBe("user:abc");
    expect(networkJoinKey("abc")).toBe("net:abc");
    expect(accountJoinKey("abc")).not.toBe(networkJoinKey("abc"));
  });
});

describe("canAttemptJoin", () => {
  it("lets a key with no history through", () => {
    expect(canAttemptJoin(undefined, T0)).toEqual({ allowed: true });
  });

  it("lets a key below the ceiling through", () => {
    const state = failTimes(JOIN_POLICY.maxFailuresPerWindow - 1);
    expect(canAttemptJoin(state, T0 + 60_000)).toEqual({ allowed: true });
  });

  it("locks out once the ceiling is reached", () => {
    const state = failTimes(JOIN_POLICY.maxFailuresPerWindow);
    const decision = canAttemptJoin(state, T0 + 60_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("throttled");
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("reopens once the lockout elapses", () => {
    const state = failTimes(JOIN_POLICY.maxFailuresPerWindow);
    const after = T0 + JOIN_POLICY.maxFailuresPerWindow * 1000 + JOIN_POLICY.lockoutMs;
    expect(canAttemptJoin(state, after)).toEqual({ allowed: true });
  });

  it("keeps a six-digit code out of reach of a script", () => {
    // The property the whole design exists for: at this rate, covering 10^6
    // codes takes years, not an afternoon.
    const perHour =
      (JOIN_POLICY.maxFailuresPerWindow * 3_600_000) /
      (JOIN_POLICY.failureWindowMs + JOIN_POLICY.lockoutMs);
    const yearsToExhaust = 1_000_000 / (perHour * 24 * 365);
    expect(yearsToExhaust).toBeGreaterThan(2);
  });
});

describe("registerJoinFailure", () => {
  it("starts a window on the first failure", () => {
    expect(registerJoinFailure(undefined, T0)).toEqual({
      failureCount: 1,
      windowStartedAt: T0,
      lastAttemptAt: T0,
    });
  });

  it("counts within the window", () => {
    const state = failTimes(3);
    expect(state?.failureCount).toBe(3);
    expect(state?.windowStartedAt).toBe(T0);
  });

  it("resets once the window has elapsed, so a mistype never accumulates", () => {
    const first = failTimes(3);
    const later = registerJoinFailure(first, T0 + JOIN_POLICY.failureWindowMs + 1);
    expect(later.failureCount).toBe(1);
    expect(later.lockedUntil).toBeUndefined();
  });

  it("sets a lockout exactly at the ceiling", () => {
    const under = failTimes(JOIN_POLICY.maxFailuresPerWindow - 1);
    expect(under?.lockedUntil).toBeUndefined();
    const at = failTimes(JOIN_POLICY.maxFailuresPerWindow);
    expect(at?.lockedUntil).toBeDefined();
  });

  it("does not re-arm the lockout on every retry", () => {
    // Otherwise a client that loops would extend its own lockout forever.
    const locked = failTimes(JOIN_POLICY.maxFailuresPerWindow);
    const again = registerJoinFailure(locked, T0 + 20_000);
    expect(again.lockedUntil).toBe(locked?.lockedUntil);
  });

  it("starts clean after a lockout has expired", () => {
    const locked = failTimes(JOIN_POLICY.maxFailuresPerWindow);
    const after = registerJoinFailure(locked, (locked?.lockedUntil ?? 0) + 1);
    expect(after.failureCount).toBe(1);
    expect(after.lockedUntil).toBeUndefined();
  });
});

describe("registerJoinSuccess", () => {
  it("hands the budget back and clears any lockout", () => {
    expect(registerJoinSuccess(T0)).toEqual({
      failureCount: 0,
      windowStartedAt: T0,
      lastAttemptAt: T0,
      lockedUntil: undefined,
    });
    expect(canAttemptJoin(registerJoinSuccess(T0), T0)).toEqual({ allowed: true });
  });
});

describe("enumeration protection", () => {
  it("gives every rejection reason the same response", () => {
    // If this test ever needs a `switch`, the protection is gone.
    const responses = new Set(JOIN_REJECTION_REASONS.map(() => JSON.stringify(joinRejected())));
    expect(responses.size).toBe(1);
    expect(joinRejected().message).toBe(JOIN_REJECTED_MESSAGE);
  });

  it("keeps the reason vocabulary out of the response shape", () => {
    expect(Object.keys(joinRejected()).sort()).toEqual(["message", "outcome"]);
  });

  it("carries nothing that could vary with the event", () => {
    // The message is a fixed string and there is no other field, so a rejection
    // is byte-identical whichever code was tried. (It does mention the word
    // "code" — it is telling the guest what to check, not what went wrong.)
    expect(joinRejected()).toEqual(joinRejected());
    expect(JSON.stringify(joinRejected())).toBe(
      JSON.stringify({ outcome: "rejected", message: JOIN_REJECTED_MESSAGE }),
    );
  });
});

describe("joinResultSchema", () => {
  it("parses each outcome", () => {
    expect(
      joinResultSchema.parse({
        outcome: "joined",
        eventId: "e1",
        membershipId: "m1",
        role: "guest",
        alreadyMember: false,
      }).outcome,
    ).toBe("joined");
    expect(joinResultSchema.parse(joinRejected()).outcome).toBe("rejected");
    expect(joinResultSchema.parse(joinThrottled(5000)).outcome).toBe("throttled");
  });

  it("agrees with the TypeScript type", () => {
    const parsed: JoinResult = joinResultSchema.parse(joinThrottled(1));
    expect(parsed.outcome).toBe("throttled");
  });

  it("rejects a role that is not an event role", () => {
    expect(
      joinResultSchema.safeParse({
        outcome: "joined",
        eventId: "e1",
        membershipId: "m1",
        role: "globalAdmin",
        alreadyMember: false,
      }).success,
    ).toBe(false);
  });
});

describe("joinInputSchema", () => {
  it("normalises a typed code", () => {
    expect(joinInputSchema.parse({ via: "code", code: "48 29-13" })).toEqual({
      via: "code",
      code: "482913",
    });
  });

  it("folds the characters Crockford base32 is meant to tolerate", () => {
    const parsed = joinInputSchema.parse({
      via: "token",
      token: "abcdefghjkmnpqrstvwxyz0123456789".toLowerCase(),
    });
    expect(parsed).toEqual({ via: "token", token: "ABCDEFGHJKMNPQRSTVWXYZ0123456789" });
  });

  it("refuses a credential that is neither", () => {
    expect(joinInputSchema.safeParse({ via: "code", code: "12345" }).success).toBe(false);
    expect(joinInputSchema.safeParse({ via: "token", token: "nope" }).success).toBe(false);
  });
});

describe("parseJoinResult", () => {
  it("passes a well-formed result through unchanged", () => {
    const joined = {
      outcome: "joined",
      eventId: "e1",
      membershipId: "m1",
      role: "guest",
      alreadyMember: false,
    };
    expect(parseJoinResult(joined)).toEqual(joined);
    expect(parseJoinResult(joinThrottled(5000))).toEqual(joinThrottled(5000));
  });

  it("fails closed: anything unparseable becomes the one rejection", () => {
    // Both clients hand-write their view of the Convex API until codegen can
    // introspect a deployment, so the compiler's idea of this payload is an
    // assertion. "Unparseable" must not become a third, distinguishable
    // outcome — that is a shape an enumeration oracle can be built out of.
    for (const bad of [
      undefined,
      null,
      {},
      "joined",
      { outcome: "maybe" },
      { outcome: "joined" },
    ]) {
      expect(parseJoinResult(bad)).toEqual(joinRejected());
    }
  });
});
