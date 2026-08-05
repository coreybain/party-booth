import { describe, expect, it } from "vitest";

import { thumbnailBoxClassName } from "@/components/media/media-thumbnail";

function widthUtilities(className: string): string[] {
  return className.split(" ").filter((utility) => utility.startsWith("w-"));
}

describe("media thumbnail sizing", () => {
  it("uses a compact width by default", () => {
    expect(widthUtilities(thumbnailBoxClassName(undefined))).toEqual(["w-20"]);
  });

  it("lets a caller own the width without retaining a conflicting full-width class", () => {
    expect(widthUtilities(thumbnailBoxClassName("w-28"))).toEqual(["w-28"]);
  });
});
