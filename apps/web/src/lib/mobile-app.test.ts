import { describe, expect, it } from "vitest";

import {
  PARTYBOOTH_APP_STORE_ID,
  PARTYBOOTH_APP_STORE_URL,
  PARTYBOOTH_APP_URL,
} from "./mobile-app";

describe("mobile app destinations", () => {
  it("builds the country-neutral App Store URL from the submitted app record", () => {
    expect(PARTYBOOTH_APP_STORE_URL).toBe(
      `https://apps.apple.com/app/id${PARTYBOOTH_APP_STORE_ID}`,
    );
  });

  it("opens through the app entry gate when no invite token is needed", () => {
    expect(PARTYBOOTH_APP_URL).toBe("partybooth://");
  });
});
