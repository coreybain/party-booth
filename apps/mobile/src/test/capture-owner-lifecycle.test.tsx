import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "@/lib/api";
import type { CaptureDraft } from "@/upload/types";

const fake = vi.hoisted(() => ({
  ownerUserId: "user_a" as string | null,
  enqueueForOwner: vi.fn(),
  buildPhotoCapture: vi.fn(),
  deleteLocalFile: vi.fn(),
}));

vi.mock("@/upload/queue-provider", () => ({
  useUploadQueue: () => ({
    ownerUserId: fake.ownerUserId,
    enqueueForOwner: fake.enqueueForOwner,
  }),
}));
vi.mock("@/upload/media-pipeline", () => ({
  buildPhotoCapture: (...args: unknown[]) => fake.buildPhotoCapture(...args),
  buildVideoCapture: vi.fn(),
}));
vi.mock("@/upload/device-store", () => ({
  deleteLocalFile: (...args: unknown[]) => fake.deleteLocalFile(...args),
}));
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

import { useCapture } from "@/hooks/use-capture";

const event: EventSummary = {
  id: "event_1",
  name: "Launch party",
  state: "live",
  moderationMode: "manual",
  startsAt: Date.now() - 1_000,
  timeZone: "Australia/Sydney",
  allowLibraryImport: true,
  storageRegion: "pdx1",
  role: "guest",
  counts: { pending: 0, approved: 0, declined: 0, total: 0 },
};

const draft: CaptureDraft = {
  captureId: "m_owner_race",
  eventId: event.id,
  mediaType: "photo",
  mediaSource: "capture",
  uri: "file:///captures/original.jpg",
  previewUri: "file:///captures/thumb.jpg",
  byteSize: 1_024,
  mimeType: "image/jpeg",
  checksum: "a".repeat(64),
  capturedAt: Date.now(),
  sourceMetadataStripped: true,
  derivatives: [
    {
      role: "preview",
      uri: "file:///captures/preview.jpg",
      byteSize: 512,
      mimeType: "image/jpeg",
      checksum: "b".repeat(64),
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fake.ownerUserId = "user_a";
  fake.enqueueForOwner
    .mockReset()
    .mockImplementation((_draft, expectedOwner: string) =>
      fake.ownerUserId === expectedOwner ? { captureId: draft.captureId } : null,
    );
  fake.buildPhotoCapture.mockReset();
  fake.deleteLocalFile.mockReset().mockResolvedValue(undefined);
});

describe("capture ownership while preparing", () => {
  it.each([
    ["sign-out", null],
    ["account switch", "user_b"],
  ])("does not attribute user A's prepared photo after %s", async (_label, nextOwner) => {
    const build = deferred<CaptureDraft>();
    fake.buildPhotoCapture.mockReturnValue(build.promise);
    const { result, rerender } = renderHook(() => useCapture(event));

    let outcomePromise!: ReturnType<typeof result.current.capture>;
    act(() => {
      outcomePromise = result.current.capture({
        source: { uri: "file:///camera/source.jpg", width: 1_200, height: 800 },
        fromLibrary: false,
      });
    });

    fake.ownerUserId = nextOwner;
    rerender();

    let outcome!: Awaited<typeof outcomePromise>;
    await act(async () => {
      build.resolve(draft);
      outcome = await outcomePromise;
    });

    expect(fake.enqueueForOwner).toHaveBeenCalledWith(draft, "user_a");
    expect(outcome).toMatchObject({ status: "refused", message: expect.stringMatching(/account/) });
    expect(fake.deleteLocalFile.mock.calls.map(([uri]) => uri)).toEqual(
      expect.arrayContaining([draft.uri, draft.previewUri, "file:///captures/preview.jpg"]),
    );
  });
});
