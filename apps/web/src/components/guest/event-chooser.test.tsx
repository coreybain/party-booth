import { describe, expect, it } from "vitest";

import { eventChoiceRoleLabel } from "./event-chooser";

describe("eventChoiceRoleLabel", () => {
  it("labels host roles and omits the guest pill", () => {
    expect(eventChoiceRoleLabel("owner")).toBe("Host");
    expect(eventChoiceRoleLabel("cohost")).toBe("Co-host");
    expect(eventChoiceRoleLabel("guest")).toBeNull();
  });
});
