import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpenInApp } from "@/components/join/open-in-app";
import { OpenPartyBoothApp } from "@/components/join/open-partybooth-app";

describe("mobile app handoff and download prompts", () => {
  it("renders no app handoff control while downloads are disabled", () => {
    expect(
      renderToStaticMarkup(<OpenPartyBoothApp deepLink="partybooth://join/test" enabled={false} />),
    ).toBe("");
  });

  it("removes the entire QR landing prompt, including its App Store copy", () => {
    expect(renderToStaticMarkup(<OpenInApp token="test-token" enabled={false} />)).toBe("");
  });

  it("restores the shared controls when downloads are deliberately enabled", () => {
    expect(
      renderToStaticMarkup(<OpenPartyBoothApp deepLink="partybooth://join/test" enabled />),
    ).toContain("Open in the PartyBooth app");
    expect(renderToStaticMarkup(<OpenInApp token="test-token" enabled />)).toContain(
      "you’ll be taken to the App Store",
    );
  });
});
