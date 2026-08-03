import { describe, expect, it } from "vitest";

import { resolveUploadAcl } from "./acl";

describe("UploadThing ACL selection", () => {
  it("keeps private storage when requested", () => {
    expect(resolveUploadAcl("private")).toBe("private");
  });

  it("uses the free-tier ACL without consulting the deployment environment", () => {
    expect(resolveUploadAcl("public-read")).toBe("public-read");
  });
});
