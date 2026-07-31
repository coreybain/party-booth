/**
 * Account and authentication boundaries around the durable upload queue.
 *
 * A phone at a party gets handed around. Persisting a file without persisting
 * who captured it lets the next signed-in guest upload and own somebody else's
 * photo, while pumping before Convex restores auth turns a healthy queued row
 * into a permanent unauthenticated failure. These tests exercise the provider
 * itself because both failures live across hydration, React props and promises.
 */

import { render, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { maxBytesForRole } from "@partybooth/contracts/media";
import { grantExpiresAt } from "@partybooth/contracts/upload";

import { serialiseQueue } from "@/upload/persistence";
import { queueItemFromDraft } from "@/upload/queue-reducer";
import {
  UploadQueueProvider,
  useUploadQueue,
  type GrantArgs,
  type UploadBackend,
} from "@/upload/queue-provider";
import { UploadCancelledError, type UploadTransport } from "@/upload/transport";

import type { CaptureDraft, QueueItem } from "@/upload/types";
import type { ReactNode } from "react";

const fake = vi.hoisted(() => ({ rawQueue: null as string | null }));

vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));
vi.mock("@/upload/device-store", () => ({
  QUEUE_FILE_NAME: "queue.json",
  CAPTURE_SETTINGS_FILE_NAME: "capture-settings.json",
  readStoreFile: (name: string) => Promise.resolve(name === "queue.json" ? fake.rawQueue : null),
  writeStoreFile: () => Promise.resolve(),
  deleteLocalFile: () => Promise.resolve(),
}));

const NOW = Date.UTC(2026, 7, 5, 19, 0, 0);

function aDraft(): CaptureDraft {
  return {
    captureId: "capture_owned_by_a",
    eventId: "event_shared",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/a-original.jpg",
    previewUri: "file:///captures/a-preview.jpg",
    byteSize: 1_200_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    capturedAt: NOW,
    sourceMetadataStripped: true,
    derivatives: [],
  };
}

function queuedFor(ownerUserId: string): QueueItem {
  return {
    ...queueItemFromDraft(aDraft(), { autoSend: true, undoDelayMs: 0 }, NOW, ownerUserId),
    state: "queued",
    sendAt: 0,
    nextAttemptAt: 0,
  };
}

function granted(args: GrantArgs) {
  const now = Date.now();
  return {
    outcome: "granted" as const,
    grantId: "grant_123",
    secret: `secret-${"x".repeat(24)}`,
    eventId: args.eventId,
    captureId: args.captureId,
    mediaType: args.mediaType,
    fileRole: args.fileRole ?? "original",
    mediaSource: args.mediaSource,
    storageRegion: "pdx1" as const,
    byteSize: args.byteSize,
    maxBytes: maxBytesForRole(args.mediaType, args.fileRole ?? "original"),
    expiresAt: grantExpiresAt(now),
  };
}

function backendThatSucceeds() {
  const requestGrant = vi.fn(async (args: GrantArgs) => granted(args));
  const confirmUpload = vi.fn(async () => ({ mediaId: "media_1" }));
  const backend: UploadBackend = { requestGrant, confirmUpload };
  return { backend, requestGrant, confirmUpload };
}

function transportThatSucceeds(): UploadTransport {
  return { upload: vi.fn(async () => {}) };
}

function mountQueue(options: {
  backend: UploadBackend;
  transport: UploadTransport;
  ownerUserId: string | null;
  enabled: boolean;
}) {
  const seen: { current: ReturnType<typeof useUploadQueue> | null } = { current: null };

  function Probe(): ReactNode {
    seen.current = useUploadQueue();
    return null;
  }

  const child = createElement(Probe);
  const view = render(
    createElement(UploadQueueProvider, {
      ...options,
      children: child,
    }),
  );

  return {
    seen,
    rerender(ownerUserId: string | null, enabled: boolean) {
      view.rerender(
        createElement(UploadQueueProvider, {
          backend: options.backend,
          transport: options.transport,
          ownerUserId,
          enabled,
          children: child,
        }),
      );
    },
  };
}

beforeEach(() => {
  fake.rawQueue = serialiseQueue([queuedFor("user_a")]);
});

describe("durable queue authentication", () => {
  it("settles a callback-completed retry without uploading or reporting failure", async () => {
    const requestGrant = vi.fn(async () => ({
      outcome: "alreadyUploaded" as const,
      mediaId: "media_already_there",
      state: "pending" as const,
    }));
    const confirmUpload = vi.fn(async () => ({ mediaId: "should_not_be_used" }));
    const reportQueueEvent = vi.fn(async () => {});
    const transport: UploadTransport = { upload: vi.fn(async () => {}) };
    const backend: UploadBackend = { requestGrant, confirmUpload, reportQueueEvent };

    const mounted = mountQueue({
      backend,
      transport,
      ownerUserId: "user_a",
      enabled: true,
    });

    await waitFor(() =>
      expect(mounted.seen.current?.items[0]).toMatchObject({
        state: "uploaded",
        mediaId: "media_already_there",
      }),
    );
    expect(transport.upload).not.toHaveBeenCalled();
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(reportQueueEvent).not.toHaveBeenCalled();
  });

  it("waits for Convex auth, then resumes for the owning account", async () => {
    const { backend, requestGrant } = backendThatSucceeds();
    const mounted = mountQueue({
      backend,
      transport: transportThatSucceeds(),
      ownerUserId: "user_a",
      enabled: false,
    });

    await waitFor(() => expect(mounted.seen.current?.hydrated).toBe(true));
    expect(mounted.seen.current?.items).toHaveLength(1);
    expect(requestGrant).not.toHaveBeenCalled();

    mounted.rerender("user_a", true);
    await waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(1));
  });

  it("keeps A's queue invisible and inert for B, then resumes when A returns", async () => {
    const { backend, requestGrant } = backendThatSucceeds();
    const mounted = mountQueue({
      backend,
      transport: transportThatSucceeds(),
      ownerUserId: "user_b",
      enabled: true,
    });

    await waitFor(() => expect(mounted.seen.current?.hydrated).toBe(true));
    expect(mounted.seen.current?.items).toEqual([]);
    expect(requestGrant).not.toHaveBeenCalled();

    mounted.rerender("user_a", true);
    await waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(1));
    expect(mounted.seen.current?.items[0]?.ownerUserId).toBe("user_a");
  });

  it("quarantines a legacy row that has no recorded owner", async () => {
    const decoded = JSON.parse(fake.rawQueue ?? "{}") as {
      items?: Record<string, unknown>[];
    };
    if (decoded.items?.[0]) delete decoded.items[0].ownerUserId;
    fake.rawQueue = JSON.stringify(decoded);

    const { backend, requestGrant } = backendThatSucceeds();
    const mounted = mountQueue({
      backend,
      transport: transportThatSucceeds(),
      ownerUserId: "user_a",
      enabled: true,
    });

    await waitFor(() => expect(mounted.seen.current?.hydrated).toBe(true));
    expect(mounted.seen.current?.items).toEqual([]);
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it("pauses an auth rejection instead of poisoning the row permanently", async () => {
    const requestGrant = vi
      .fn<(args: GrantArgs) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new ConvexError({ code: "unauthenticated", message: "Sign in to continue." }),
      )
      .mockImplementation(async (args) => granted(args));
    const backend: UploadBackend = {
      requestGrant,
      confirmUpload: async () => ({ mediaId: "media_1" }),
    };
    const mounted = mountQueue({
      backend,
      transport: transportThatSucceeds(),
      ownerUserId: "user_a",
      enabled: true,
    });

    await waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mounted.seen.current?.items[0]?.state).toBe("queued"));

    // The local auth pause stops an immediate retry while Convex's auth hook
    // catches up with the rejected token.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(requestGrant).toHaveBeenCalledTimes(1);

    mounted.rerender("user_a", false);
    await waitFor(() => expect(mounted.seen.current?.items[0]?.state).toBe("queued"));
    mounted.rerender("user_a", true);
    await waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(2));
  });

  it("aborts A's in-flight bytes when the active account changes", async () => {
    const { backend, requestGrant } = backendThatSucceeds();
    let first = true;
    const transport: UploadTransport = {
      upload: vi.fn(
        (request) =>
          new Promise<void>((resolve, reject) => {
            if (!first) {
              resolve();
              return;
            }
            first = false;
            request.signal?.addEventListener("abort", () => reject(new UploadCancelledError()), {
              once: true,
            });
          }),
      ),
    };
    const mounted = mountQueue({ backend, transport, ownerUserId: "user_a", enabled: true });

    await waitFor(() => expect(transport.upload).toHaveBeenCalledTimes(1));
    mounted.rerender("user_b", true);

    await waitFor(() => expect(mounted.seen.current?.items).toEqual([]));
    expect(requestGrant).toHaveBeenCalledTimes(1);

    mounted.rerender("user_a", true);
    await waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(2));
  });
});
