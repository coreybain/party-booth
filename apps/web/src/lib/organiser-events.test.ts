import { describe, expect, it } from "vitest";

import { organiserEvents } from "./organiser-events";

describe("organiserEvents", () => {
  it("keeps owned and co-hosted events out of ordinary guest memberships", () => {
    const events = [
      { id: "owned", role: "owner" as const },
      { id: "cohosted", role: "cohost" as const },
      { id: "joined-by-qr", role: "guest" as const },
    ];

    expect(organiserEvents(events).map((event) => event.id)).toEqual(["owned", "cohosted"]);
  });
});
