import { describe, expect, it } from "vitest";

import { resolveUploadAcl } from "./acl";

describe("UploadThing ACL selection", () => {
  it("keeps private storage in every environment by default", () => {
    for (const deploymentEnvironment of ["development", "preview", "production"] as const) {
      expect(
        resolveUploadAcl({
          requested: "private",
          deploymentEnvironment,
          deploymentEnvironmentIsExplicit: true,
        }),
      ).toBe("private");
    }
  });

  it("allows the free-tier public ACL in an explicit development deployment", () => {
    expect(
      resolveUploadAcl({
        requested: "public-read",
        deploymentEnvironment: "development",
        deploymentEnvironmentIsExplicit: true,
      }),
    ).toBe("public-read");
  });

  it.each(["preview", "production"] as const)(
    "refuses public storage in %s",
    (deploymentEnvironment) => {
      expect(() =>
        resolveUploadAcl({
          requested: "public-read",
          deploymentEnvironment,
          deploymentEnvironmentIsExplicit: true,
        }),
      ).toThrow(/allowed only/);
    },
  );

  it("refuses public storage when development came from the schema default", () => {
    expect(() =>
      resolveUploadAcl({
        requested: "public-read",
        deploymentEnvironment: "development",
        deploymentEnvironmentIsExplicit: false,
      }),
    ).toThrow(/explicitly set/);
  });
});
