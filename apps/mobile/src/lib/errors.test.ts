import { ERROR_CODES } from "@partybooth/backend";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { describeError, requiresSignIn } from "./errors";

/** The shape `packages/backend/convex/lib/errors.ts` throws. */
function appError(code: string, message: string, extra: Record<string, number> = {}) {
  return new ConvexError({ code, message, ...extra });
}

describe("describeError", () => {
  it("has an answer for every code the backend can throw", () => {
    // A new code with no entry here would fall through to "something went wrong",
    // which is exactly the outcome the structured payload exists to avoid.
    for (const code of ERROR_CODES) {
      const copy = describeError(appError(code, "Backend copy."));
      expect(copy.title).not.toBe("Something went wrong");
      expect(copy.message).toBe("Backend copy.");
    }
  });

  it("shows the backend's own sentence, which is already written for a guest", () => {
    const copy = describeError(appError("forbidden", "You do not have permission to do that."));
    expect(copy.message).toBe("You do not have permission to do that.");
    expect(copy.recovery).toBe("none");
  });

  it("carries a retry delay through when the backend attached one", () => {
    const copy = describeError(appError("rateLimited", "Too many.", { retryAfterMs: 60_000 }));
    expect(copy.recovery).toBe("wait");
    expect(copy.retryAfterMs).toBe(60_000);
  });

  it("ignores a nonsense retry delay rather than rendering it", () => {
    expect(
      describeError(appError("rateLimited", "Too many.", { retryAfterMs: -1 })).retryAfterMs,
    ).toBeUndefined();
  });

  it("never surfaces a raw error message from something unmodelled", () => {
    // Convex puts internal detail in the message of an unexpected server error. A
    // stack fragment on a guest's phone is noise at best and a leak at worst.
    const copy = describeError(new Error("TypeError: cannot read property 'x' of undefined"));
    expect(copy.message).not.toContain("TypeError");
    expect(copy.recovery).toBe("retry");
  });

  it("treats a dropped connection as retryable, because on party Wi-Fi it usually is", () => {
    expect(describeError(undefined).recovery).toBe("retry");
    expect(describeError("network request failed").recovery).toBe("retry");
  });

  it("falls back safely for a code from a deployment newer than this build", () => {
    const copy = describeError(appError("someFutureCode", "Backend copy."));
    expect(copy.title).toBe("Something went wrong");
    expect(copy.message).toBe("Backend copy.");
    expect(copy.recovery).toBe("retry");
  });
});

describe("requiresSignIn", () => {
  it("is true only for the codes that mean the session is unusable", () => {
    expect(requiresSignIn(appError("unauthenticated", "Sign in to continue."))).toBe(true);
    expect(requiresSignIn(appError("accountDeleted", "Closed."))).toBe(true);
    // A lock is an admin action against this account: signing out and back in would
    // hide the explanation rather than lift it.
    expect(requiresSignIn(appError("accountLocked", "Locked."))).toBe(false);
    expect(requiresSignIn(appError("forbidden", "No."))).toBe(false);
    expect(requiresSignIn(new Error("offline"))).toBe(false);
  });
});
