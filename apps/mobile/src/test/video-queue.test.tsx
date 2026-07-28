/**
 * A video going through the whole durable queue, with two fakes.
 *
 * The queue provider is the one piece of the upload spine that cannot be tested
 * as a pure function — it owns the promises, the timers and the Convex calls —
 * so it takes its backend and its transport as parameters precisely so that a
 * test can supply both. This is the video half of that: one clip, one original
 * grant, one poster grant, in the right order, and nothing extra.
 *
 * The properties it is here to protect, each of which fails silently:
 *
 * - **The poster is a second grant under the same `captureId`**, with
 *   `fileRole: "poster"` and `sourceMetadataStripped: true` — the flag is a
 *   *precondition* on a derivative, not a record, so a grant sent without it is
 *   refused outright (ADR 0008).
 * - **The poster goes after the original**, never before. `derivativeWithoutOriginal`
 *   is retryable, so getting this wrong would still work — slowly, and only on
 *   a good network.
 * - **`confirmUpload` is called once**, for the original. A derivative attaches
 *   a key and stops; calling it again would be a second completion for one
 *   submission.
 * - **A failed poster does not fail the video.**
 */

import { render, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { maxBytesForRole } from "@partybooth/contracts/media";
import { grantExpiresAt } from "@partybooth/contracts/upload";

import { createFakeTransport } from "@/upload/transport";
import {
  UploadQueueProvider,
  useUploadQueue,
  type GrantArgs,
  type UploadBackend,
} from "@/upload/queue-provider";

import type { CaptureDraft } from "@/upload/types";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

// The filesystem is not the subject here. `device-store` is the only module in
// the queue that touches it, and every function in it is already documented as
// swallowing its own errors.
vi.mock("@/upload/device-store", () => ({
  QUEUE_FILE_NAME: "queue.json",
  CAPTURE_SETTINGS_FILE_NAME: "capture-settings.json",
  readStoreFile: () => Promise.resolve(null),
  writeStoreFile: () => Promise.resolve(),
  deleteLocalFile: () => Promise.resolve(),
}));

/** A backend that records every grant request and answers them in order. */
function fakeBackend(options: { refuseRole?: string } = {}) {
  const grants: GrantArgs[] = [];
  const confirmations: string[] = [];
  let issued = 0;

  const backend: UploadBackend = {
    requestGrant: (args) => {
      grants.push(args);
      if (options.refuseRole !== undefined && args.fileRole === options.refuseRole) {
        return Promise.resolve({
          outcome: "rejected",
          reason: "duplicateDerivative",
          message: "That preview has already been uploaded.",
        });
      }
      issued += 1;
      const now = Date.now();
      const role = args.fileRole ?? "original";
      // Exactly the shape `issuedGrantSchema` accepts, because the queue
      // re-parses with `parseGrantResult` before it branches — an assertion is
      // not a check, and the next thing that happens to a grant is that bytes
      // get sent on the strength of it. A fake that skipped a field here would
      // be testing a code path the server can never produce.
      return Promise.resolve({
        outcome: "granted",
        grantId: `grant_${String(issued)}`,
        // The schema demands at least sixteen characters: it is a capability.
        secret: `secret-${String(issued)}-${"x".repeat(16)}`,
        eventId: args.eventId,
        captureId: args.captureId,
        mediaType: args.mediaType,
        fileRole: role,
        mediaSource: args.mediaSource,
        storageRegion: "pdx1",
        byteSize: args.byteSize,
        maxBytes: maxBytesForRole(args.mediaType, role),
        expiresAt: grantExpiresAt(now),
      });
    },
    confirmUpload: (secret) => {
      confirmations.push(secret);
      return Promise.resolve({ mediaId: "media_1" });
    },
  };

  return { backend, grants, confirmations };
}

function aVideoDraft(): CaptureDraft {
  return {
    captureId: "m_video",
    eventId: "event_1",
    mediaType: "video",
    mediaSource: "capture",
    uri: "file:///captures/m_video-original.mov",
    previewUri: "file:///captures/m_video-share-poster.jpg",
    byteSize: 42_000_000,
    mimeType: "video/quicktime",
    checksum: "a".repeat(64),
    durationSeconds: 11.4,
    capturedAt: Date.now(),
    // What `buildVideoCapture` really produces: no transcoder exists, so the
    // re-encode claim is `false` — and the location claim is `true` on its own,
    // because the app ships no location permission on either platform.
    sourceMetadataStripped: false,
    sourceCarriesNoLocation: true,
    derivatives: [
      {
        role: "poster",
        uri: "file:///captures/m_video-share-poster.jpg",
        byteSize: 250_000,
        mimeType: "image/jpeg",
        checksum: "b".repeat(64),
        width: 1280,
        height: 720,
      },
    ],
  };
}

/** Mounts the provider, enqueues one draft, and exposes the live queue value. */
function mountWithDraft(
  backend: UploadBackend,
  transport: ReturnType<typeof createFakeTransport>,
  draft: CaptureDraft,
) {
  const seen: { current: ReturnType<typeof useUploadQueue> | null } = { current: null };

  function Probe(): ReactNode {
    const queue = useUploadQueue();
    seen.current = queue;

    useEffect(() => {
      if (!queue.hydrated) return;
      if (queue.items.length > 0) return;
      queue.enqueue(draft);
    }, [queue]);

    // Skip the fifteen-second undo window by pressing "Send now", which is a
    // real control on the camera screen. Waiting it out would make this file
    // take a minute, and the countdown itself is `countdown.test.ts`'s job —
    // what this one is about is everything that happens after it closes.
    useEffect(() => {
      const waiting = queue.items.find((item) => item.state === "captured");
      if (waiting === undefined) return;
      queue.sendNow(waiting.captureId);
    }, [queue]);

    return null;
  }

  render(
    createElement(UploadQueueProvider, {
      backend,
      transport,
      children: createElement(Probe),
    }),
  );

  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("a video through the queue", () => {
  it("sends the original, then the poster, under one captureId", async () => {
    const { backend, grants, confirmations } = fakeBackend();
    const transport = createFakeTransport();
    mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(
      () => {
        expect(grants).toHaveLength(2);
      },
      { timeout: 5_000 },
    );

    // Order is the assertion. `derivativeWithoutOriginal` is deliberately
    // retryable, so the wrong order would still work — slowly, and only on a
    // good network, which is not what a party has.
    expect(grants[0]?.fileRole).toBeUndefined();
    expect(grants[1]?.fileRole).toBe("poster");

    // One capture, one id, however many objects it arrives as.
    expect(grants[0]?.captureId).toBe("m_video");
    expect(grants[1]?.captureId).toBe("m_video");

    // A derivative attaches a key and stops: no state change, no counter, no
    // second completion.
    await waitFor(() => {
      expect(confirmations).toEqual([`secret-1-${"x".repeat(16)}`]);
    });

    expect(transport.requests).toHaveLength(2);
  });

  it("declares the video's duration on the original's grant", async () => {
    // `validateMediaFile` refuses a video grant without one, and the server
    // re-checks it against the object that actually landed.
    const { backend, grants } = fakeBackend();
    const transport = createFakeTransport();
    mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(() => {
      expect(grants.length).toBeGreaterThanOrEqual(1);
    });
    expect(grants[0]).toMatchObject({
      mediaType: "video",
      mimeType: "video/quicktime",
      durationSeconds: 11.4,
      byteSize: 42_000_000,
    });
  });

  it("splits the metadata claim on the original, rather than overstating it", async () => {
    const { backend, grants } = fakeBackend();
    const transport = createFakeTransport();
    mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(() => {
      expect(grants.length).toBeGreaterThanOrEqual(1);
    });

    // The regression this exists for: a single flag forced this path to assert a
    // re-encode it had not performed in order to get the visibility it had
    // honestly earned. `mayServeOriginal` reads the location half, so the clip is
    // still shown to fellow guests — and now the sentence is true.
    expect(grants[0]?.sourceMetadataStripped).toBe(false);
    expect(grants[0]?.sourceCarriesNoLocation).toBe(true);
  });

  it("claims the re-encode on the poster, which its grant requires", async () => {
    const { backend, grants } = fakeBackend();
    const transport = createFakeTransport();
    mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(() => {
      expect(grants).toHaveLength(2);
    });

    const poster = grants[1];
    // On a derivative this is a precondition, not a record: the grant is refused
    // without it, because the derivative is what third parties are served.
    expect(poster?.sourceMetadataStripped).toBe(true);
    expect(poster?.byteSize).toBe(250_000);
    expect(poster?.mimeType).toBe("image/jpeg");
    // A poster is a still. Demanding a duration would refuse every legitimate
    // video thumbnail.
    expect(poster?.durationSeconds).toBeUndefined();
  });

  it("sends the poster's own bytes, not the video's", async () => {
    const { backend } = fakeBackend();
    const transport = createFakeTransport();
    mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(() => {
      expect(transport.requests).toHaveLength(2);
    });

    expect(transport.requests[0]?.file.uri).toBe("file:///captures/m_video-original.mov");
    expect(transport.requests[1]?.file.uri).toBe("file:///captures/m_video-share-poster.jpg");
    // The ticket is built by the contract from the grant, so it describes what
    // was actually authorised rather than this row's own copy of those facts.
    expect(transport.requests[1]?.ticket.captureId).toBe("m_video");
  });

  it("leaves the capture uploaded once both objects have gone", async () => {
    const { backend } = fakeBackend();
    const transport = createFakeTransport();
    const seen = mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(() => {
      const item = seen.current?.items[0];
      expect(item?.state).toBe("uploaded");
      expect(item?.derivatives[0]?.state).toBe("uploaded");
    });
  });
});

/* -------------------------------------------------------------------------- */
/* A poster that does not make it                                             */
/* -------------------------------------------------------------------------- */

describe("a video whose poster fails", () => {
  it("keeps the video, and gives up on the thumbnail", async () => {
    // A missing derivative never strands a capture — the whole reason
    // `mayServeOriginal`'s "serve nothing" branch survived Sprint 4.
    const { backend, confirmations } = fakeBackend({ refuseRole: "poster" });
    const transport = createFakeTransport();
    const seen = mountWithDraft(backend, transport, aVideoDraft());

    await waitFor(
      () => {
        expect(seen.current?.items[0]?.derivatives[0]?.state).toBe("abandoned");
      },
      { timeout: 5_000 },
    );

    const item = seen.current?.items[0];
    // The photograph is in the party. Its thumbnail is not, and that is not the
    // guest's problem and not shown to them.
    expect(item?.state).toBe("uploaded");
    expect(item?.failure).toBeUndefined();
    expect(confirmations).toEqual([`secret-1-${"x".repeat(16)}`]);
    // Only the original's bytes moved.
    expect(transport.requests).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Photos get a preview too                                                   */
/* -------------------------------------------------------------------------- */

describe("a photo through the queue", () => {
  it("sends a preview derivative alongside the original", async () => {
    // The Sprint 3 carry-over, on the client half: something now writes a
    // `previewKey`, so `mayServeOriginal`'s branch has a derivative to serve.
    const { backend, grants } = fakeBackend();
    const transport = createFakeTransport();

    const photo: CaptureDraft = {
      captureId: "m_photo",
      eventId: "event_1",
      mediaType: "photo",
      mediaSource: "capture",
      uri: "file:///captures/m_photo-original.jpg",
      previewUri: "file:///captures/m_photo-preview.jpg",
      byteSize: 3_100_000,
      mimeType: "image/jpeg",
      checksum: "c".repeat(64),
      capturedAt: Date.now(),
      sourceMetadataStripped: true,
      derivatives: [
        {
          role: "preview",
          uri: "file:///captures/m_photo-share-preview.jpg",
          byteSize: 310_000,
          mimeType: "image/jpeg",
          checksum: "d".repeat(64),
          width: 1280,
          height: 960,
        },
      ],
    };

    mountWithDraft(backend, transport, photo);

    await waitFor(
      () => {
        expect(grants).toHaveLength(2);
      },
      { timeout: 5_000 },
    );
    expect(grants[1]).toMatchObject({
      fileRole: "preview",
      sourceMetadataStripped: true,
      byteSize: 310_000,
    });
    // Comfortably inside `DERIVATIVE_LIMITS.image.maxBytes` (2 MiB), which is
    // what `checkGrantEligibility` would hold it to.
    expect(grants[1]?.byteSize).toBeLessThan(2 * 1024 * 1024);
  });
});
