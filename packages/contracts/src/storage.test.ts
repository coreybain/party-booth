import { STORAGE_REGIONS as ENV_STORAGE_REGIONS } from "@partybooth/env";
import { describe, expect, it } from "vitest";

import {
  isStorageRegion,
  STORAGE_REGION_LABELS,
  STORAGE_REGIONS,
  storageRegionSchema,
} from "./storage";

describe("storage regions", () => {
  it("is the single beta region from PLAN.md", () => {
    expect(STORAGE_REGIONS).toEqual(["pdx1"]);
  });

  it("stays in step with the STORAGE_DEFAULT_REGION enum in @partybooth/env", () => {
    // The two packages declare the list independently — env parses it out of the
    // environment, contracts stores it on the event. If they ever drift, an
    // event could be created in a region the uploader cannot resolve.
    expect([...STORAGE_REGIONS]).toEqual([...ENV_STORAGE_REGIONS]);
  });

  it("labels every region", () => {
    for (const region of STORAGE_REGIONS) {
      expect(STORAGE_REGION_LABELS[region]).toBeTruthy();
    }
  });

  it("validates", () => {
    expect(isStorageRegion("pdx1")).toBe(true);
    expect(isStorageRegion("iad1")).toBe(false);
    expect(isStorageRegion(undefined)).toBe(false);
    expect(storageRegionSchema.safeParse("pdx1").success).toBe(true);
    expect(storageRegionSchema.safeParse("sfo1").success).toBe(false);
  });
});
