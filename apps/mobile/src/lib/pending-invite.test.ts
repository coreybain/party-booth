import { beforeEach, describe, expect, it } from "vitest";

import {
  peekPendingInvite,
  pendingInviteParam,
  rememberPendingInvite,
  takePendingInvite,
} from "./pending-invite";

const TOKEN = "7KD2QP9RX4TV1WM8ZB3NC6HS5JAEFGTV";

describe("pending invite", () => {
  beforeEach(() => {
    rememberPendingInvite(null);
  });

  it("holds nothing by default", () => {
    expect(peekPendingInvite()).toBeNull();
    expect(takePendingInvite()).toBeNull();
  });

  it("survives the sign-in detour a scanned QR forces", () => {
    rememberPendingInvite({ kind: "token", token: TOKEN });
    expect(peekPendingInvite()).toEqual({ kind: "token", token: TOKEN });
  });

  it("is consumed by reading, so the entry gate cannot loop back into the join screen", () => {
    rememberPendingInvite({ kind: "code", code: "428913" });
    expect(takePendingInvite()).toEqual({ kind: "code", code: "428913" });
    expect(takePendingInvite()).toBeNull();
    expect(peekPendingInvite()).toBeNull();
  });

  it("is cleared explicitly with null", () => {
    rememberPendingInvite({ kind: "token", token: TOKEN });
    rememberPendingInvite(null);
    expect(peekPendingInvite()).toBeNull();
  });

  it("hands `/join/[token]` the raw credential, whichever kind it is", () => {
    expect(pendingInviteParam({ kind: "token", token: TOKEN })).toBe(TOKEN);
    expect(pendingInviteParam({ kind: "code", code: "428913" })).toBe("428913");
  });
});
