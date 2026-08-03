import { describe, expect, it } from "vitest";

import {
  MIN_SIGNED_URL_REFRESH_INTERVAL_MS,
  signedUrlRefreshIntervalMs,
} from "@/lib/use-signed-url-refresh";

describe("signed URL refresh interval", () => {
  it("refreshes at three quarters of the URL lifetime", () => {
    expect(signedUrlRefreshIntervalMs(60)).toBe(45_000);
    expect(signedUrlRefreshIntervalMs(600)).toBe(450_000);
  });

  it("never creates a timer that spins faster than one second", () => {
    expect(signedUrlRefreshIntervalMs(0)).toBe(MIN_SIGNED_URL_REFRESH_INTERVAL_MS);
  });
});
