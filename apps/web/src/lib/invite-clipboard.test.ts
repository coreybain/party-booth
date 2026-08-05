import { describe, expect, it } from "vitest";

import {
  inviteClipboardHtml,
  inviteClipboardText,
  inviteCopyMenuItems,
  type InviteClipboardDetails,
} from "@/lib/invite-clipboard";

const DETAILS: InviteClipboardDetails = {
  eventName: "Mia & Sam's party",
  groupedCode: "877 172",
  url: "https://www.partybooth.dev/join/private-token",
};

describe("invite clipboard", () => {
  it("offers every invite representation when the join URL is available", () => {
    expect(inviteCopyMenuItems(true).map(({ action }) => action)).toEqual([
      "qr",
      "code",
      "link",
      "all",
    ]);
  });

  it("only offers the six-digit code when the support view withholds the token", () => {
    expect(inviteCopyMenuItems(false)).toEqual([
      { action: "code", label: "Copy six-digit code", copiedLabel: "Code copied" },
    ]);
  });

  it("formats a useful plain-text paste with the code and direct link", () => {
    expect(inviteClipboardText(DETAILS)).toBe(
      "Mia & Sam's party\nJoin code: 877 172\nJoin link: https://www.partybooth.dev/join/private-token",
    );
  });

  it("builds a safe rich paste with an embedded QR and clickable join link", () => {
    const html = inviteClipboardHtml(
      { ...DETAILS, eventName: '<img src=x onerror="bad">' },
      "data:image/png;base64,qr",
    );

    expect(html).toContain('src="data:image/png;base64,qr"');
    expect(html).toContain('href="https://www.partybooth.dev/join/private-token"');
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="bad">');
  });
});
