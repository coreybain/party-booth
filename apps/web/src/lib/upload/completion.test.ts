import { describe, expect, it } from "vitest";

import { clientUploadCompletion } from "./completion";

describe("clientUploadCompletion", () => {
  it("accepts only callback outcomes that attached or already owned the file", () => {
    expect(clientUploadCompletion({ outcome: "registered", state: "pending" })).toEqual({
      ok: true,
      state: "pending",
    });
    expect(clientUploadCompletion({ outcome: "duplicate", state: "approved" })).toEqual({
      ok: true,
      state: "approved",
    });
  });

  it("keeps a transient callback refusal retryable", () => {
    expect(clientUploadCompletion({ outcome: "rejected", reason: "unknownGrant" })).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("does not retry a body the server permanently discarded", () => {
    expect(clientUploadCompletion({ outcome: "discarded", reason: "withdrawn" })).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("fails closed on malformed provider serverData", () => {
    expect(() => clientUploadCompletion({ outcome: "surprise" })).toThrow();
  });
});
