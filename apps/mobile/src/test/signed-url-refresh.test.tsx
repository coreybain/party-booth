import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signedUrlRefreshIntervalMs, useSignedUrlRefreshKey } from "@/hooks/use-signed-url-refresh";

describe("signed URL subscription refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T20:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules host and gallery refreshes at three quarters of their TTL", () => {
    expect(signedUrlRefreshIntervalMs(60)).toBe(45_000);
    expect(signedUrlRefreshIntervalMs(10 * 60)).toBe(450_000);
  });

  it("advances the query key before the signed URL expires", () => {
    const intervalMs = signedUrlRefreshIntervalMs(60);
    const hook = renderHook(() => useSignedUrlRefreshKey(60));
    const first = hook.result.current;

    act(() => vi.advanceTimersByTime(intervalMs - 1));
    expect(hook.result.current).toBe(first);

    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current).toBe(first + 1);
  });
});
