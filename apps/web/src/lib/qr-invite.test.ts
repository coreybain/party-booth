import { describe, expect, it } from "vitest";

import { inviteTokenFromQr } from "@/lib/qr-invite";

const TOKEN = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

describe("inviteTokenFromQr", () => {
  it("accepts a production-style HTTPS invite", () => {
    expect(inviteTokenFromQr(`https://partybooth.app/join/${TOKEN}`)).toBe(TOKEN);
  });

  it("accepts the app scheme and normalises a transcribed token", () => {
    expect(inviteTokenFromQr(`partybooth://join/${TOKEN.toLowerCase()}`)).toBe(TOKEN);
  });

  it.each([
    "https://example.com/not-a-party",
    "https://example.com/join/123456",
    "data:text/plain,/join/ABCDEFGHJKMNPQRSTVWXYZ0123456789",
    "not a url",
  ])("rejects a non-invite QR: %s", (value) => {
    expect(inviteTokenFromQr(value)).toBeNull();
  });
});
