import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAppError, appErrorMessage } from "@/lib/app-errors";

import {
  requestUploadGrant,
  UPLOAD_GRANT_API_PATH,
  UPLOAD_GRANT_TIMEOUT_MS,
} from "./grant-transport";

const request = {
  eventId: "event-1",
  captureId: "w".padEnd(33, "a"),
  mediaType: "photo" as const,
  byteSize: 1_024,
  mimeType: "image/jpeg",
  checksum: "b".repeat(64),
  mediaSource: "capture" as const,
  sourceMetadataStripped: true,
  capturedAt: 1_786_000_000_000,
};

const grant = {
  outcome: "granted",
  grantId: "grant-1",
  secret: "s".repeat(32),
  eventId: request.eventId,
  captureId: request.captureId,
  mediaType: "photo",
  fileRole: "original",
  mediaSource: "capture",
  storageRegion: "pdx1",
  byteSize: request.byteSize,
  maxBytes: 20 * 1024 * 1024,
  expiresAt: 1_786_000_120_000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestUploadGrant", () => {
  it("uses the authenticated HTTP bridge instead of the Convex socket", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: grant })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestUploadGrant(request)).resolves.toMatchObject({ outcome: "granted" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_GRANT_API_PATH);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("passes documented refusal values through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                outcome: "rejected",
                reason: "eventNotAcceptingUploads",
                message: "This event is not accepting uploads right now.",
              },
            }),
          ),
      ),
    );

    await expect(requestUploadGrant(request)).resolves.toMatchObject({
      outcome: "rejected",
      reason: "eventNotAcceptingUploads",
    });
  });

  it("preserves an authenticated backend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: "unauthenticated", message: "Sign in again." },
            }),
            { status: 400 },
          ),
      ),
    );

    await requestUploadGrant(request).catch((error: unknown) => {
      expect(error).toBeInstanceOf(RemoteAppError);
      expect(appErrorMessage(error)).toBe("Sign in again.");
    });
  });

  it("turns a dropped request into recoverable party-Wi-Fi copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await requestUploadGrant(request).catch((error: unknown) => {
      expect(appErrorMessage(error)).toMatch(/offline/i);
    });
  });

  it("aborts the bridge request when the guest cancels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const controller = new AbortController();
    const pending = requestUploadGrant(request, controller.signal);
    const assertion = expect(pending).rejects.toThrow("Upload cancelled");
    controller.abort();
    await assertion;
  });

  it("times out instead of leaving the queue on Starting forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const pending = requestUploadGrant(request);
    const assertion = expect(pending).rejects.toSatisfy((error: unknown) =>
      appErrorMessage(error).includes("too long"),
    );
    await vi.advanceTimersByTimeAsync(UPLOAD_GRANT_TIMEOUT_MS);
    await assertion;
  });
});
