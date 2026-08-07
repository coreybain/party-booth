import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreBadges } from "@/components/join/store-badges";

describe("mobile app download prompt", () => {
  it("renders nothing while mobile app downloads are disabled", () => {
    expect(renderToStaticMarkup(<StoreBadges enabled={false} />)).toBe("");
  });

  it("can be restored by enabling the shared feature flag", () => {
    expect(renderToStaticMarkup(<StoreBadges enabled />)).toContain("Apps for iPhone and Android");
  });
});
