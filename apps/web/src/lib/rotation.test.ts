import { describe, expect, it } from "vitest";

import { ROTATION_POLICY } from "@/lib/contracts";
import {
  canConfirmRotation,
  emptyRotationBudget,
  formatRotationCountdown,
  initialRotationStep,
  keepExistingMemberships,
  recordRotation,
  recordRotationRefusal,
  ROTATION_CONSEQUENCES,
  rotationAvailability,
  rotationReducer,
  rotationsRemaining,
  type RotationEvent,
  type RotationStep,
} from "@/lib/rotation";

function run(events: readonly RotationEvent[], from: RotationStep = initialRotationStep) {
  return events.reduce(rotationReducer, from);
}

describe("the rotation modal forces the keep-or-revoke choice", () => {
  it("opens with nothing selected, and confirm is dead until one is", () => {
    const opened = run([{ type: "open" }]);
    expect(opened).toEqual({ kind: "choosing" });
    expect(canConfirmRotation(opened)).toBe(false);

    const chosen = run([{ type: "choose", choice: "revoke" }], opened);
    expect(canConfirmRotation(chosen)).toBe(true);
  });

  it("ignores a confirm with no choice rather than defaulting to one", () => {
    // The contract's `keepExistingMemberships` defaults to `true`. A dialog that
    // inherited that default would silently keep a guest list the host opened
    // this dialog to clear.
    const step = run([{ type: "open" }, { type: "confirm" }]);
    expect(step).toEqual({ kind: "choosing" });
  });

  it("re-opening starts blank, so the second rotation does not repeat the first", () => {
    const done = run([
      { type: "open" },
      { type: "choose", choice: "revoke" },
      { type: "confirm" },
      {
        type: "succeeded",
        outcome: { version: 2, code: "123456", token: "t", revokedMemberships: 9 },
      },
    ]);
    expect(done.kind).toBe("done");

    expect(run([{ type: "close" }, { type: "open" }], done)).toEqual({ kind: "choosing" });
  });

  it("keeps the choice through a failure so a retry does not re-ask", () => {
    const failed = run([
      { type: "open" },
      { type: "choose", choice: "keep" },
      { type: "confirm" },
      { type: "failed", message: "Nope", retryAfterMs: 1_000 },
    ]);
    expect(failed).toEqual({
      kind: "failed",
      choice: "keep",
      message: "Nope",
      retryAfterMs: 1_000,
    });
    // …but it is still re-choosable, because the failure may have been the
    // reason to change one's mind.
    expect(run([{ type: "choose", choice: "revoke" }], failed)).toEqual({
      kind: "choosing",
      choice: "revoke",
    });
  });

  it("cannot succeed out of a step that never sent anything", () => {
    const outcome = { version: 2, code: "123456", token: "t", revokedMemberships: 0 };
    expect(run([{ type: "open" }, { type: "succeeded", outcome }])).toEqual({ kind: "choosing" });
  });

  it("maps each choice onto the argument the mutation takes", () => {
    expect(keepExistingMemberships("keep")).toBe(true);
    expect(keepExistingMemberships("revoke")).toBe(false);
  });

  it("says out loud that a sweep keeps co-hosts and deletes nothing", () => {
    const revoke = ROTATION_CONSEQUENCES.revoke.effects.join(" ");
    expect(revoke).toMatch(/co-hosts are kept/i);
    expect(revoke).toMatch(/nothing is deleted/i);
  });
});

describe("the rotation budget", () => {
  const t0 = 1_700_000_000_000;

  it("allows the first rotation and blocks the sixth within the hour", () => {
    let budget = emptyRotationBudget;
    for (let i = 0; i < ROTATION_POLICY.maxPerWindow; i += 1) {
      expect(rotationAvailability(budget, t0 + i).allowed).toBe(true);
      budget = recordRotation(budget, t0 + i);
    }
    expect(rotationsRemaining(budget, t0)).toBe(0);

    const blocked = rotationAvailability(budget, t0 + 1_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("frees up again once the window has rolled over", () => {
    let budget = emptyRotationBudget;
    for (let i = 0; i < ROTATION_POLICY.maxPerWindow; i += 1) budget = recordRotation(budget, t0);
    expect(rotationAvailability(budget, t0 + ROTATION_POLICY.windowMs).allowed).toBe(true);
    expect(rotationsRemaining(budget, t0 + ROTATION_POLICY.windowMs)).toBe(
      ROTATION_POLICY.maxPerWindow,
    );
  });

  it("lets the server's refusal outlast what this session happens to remember", () => {
    // A page that has just loaded has counted nothing, so only the `rateLimited`
    // error knows the button should be dead.
    const budget = recordRotationRefusal(emptyRotationBudget, t0, 90_000);
    const blocked = rotationAvailability(budget, t0 + 1_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMs).toBe(89_000);
    expect(rotationAvailability(budget, t0 + 90_001).allowed).toBe(true);
  });

  it("ignores a refusal that carried no retry hint", () => {
    expect(recordRotationRefusal(emptyRotationBudget, t0, undefined)).toEqual(emptyRotationBudget);
    expect(
      rotationAvailability(recordRotationRefusal(emptyRotationBudget, t0, 0), t0).allowed,
    ).toBe(true);
  });

  it("rounds the countdown up, so a live button never reads 0 s", () => {
    expect(formatRotationCountdown(1)).toBe("1 s");
    expect(formatRotationCountdown(59_000)).toBe("59 s");
    expect(formatRotationCountdown(59_500)).toBe("1 min");
    expect(formatRotationCountdown(60 * 60_000)).toBe("1 h");
    expect(formatRotationCountdown(-5)).toBe("0 s");
  });
});
