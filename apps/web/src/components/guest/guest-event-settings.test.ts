import { describe, expect, it } from "vitest";

import { eventRoleLabel } from "@/components/guest/guest-event-settings";

describe("guest event settings", () => {
  it("makes each event relationship explicit in the mobile selector", () => {
    expect(eventRoleLabel("owner")).toBe("Host");
    expect(eventRoleLabel("cohost")).toBe("Co-host");
    expect(eventRoleLabel("guest")).toBe("Guest");
  });
});
