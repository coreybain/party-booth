import { describe, expect, it } from "vitest";

import { emptyUploadQueue, findItem, uploadReducer, type CapturedPayload } from "./machine";
import { alreadyUploadedActions } from "./reconciliation";

const CAPTURE_ID = "w0123456789abcdef0123456789abcdef";

function capture(): CapturedPayload {
  return {
    captureId: CAPTURE_ID,
    mediaType: "photo",
    mediaSource: "capture",
    file: new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }),
    byteSize: 4,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    metadataStripped: true,
    createdAt: 1_700_000_000_000,
  };
}

describe("alreadyUploadedActions", () => {
  it("reconciles a queued capture through legal states without sending bytes", () => {
    let queue = uploadReducer(emptyUploadQueue, { type: "captured", capture: capture() });
    queue = uploadReducer(queue, { type: "queued", captureId: CAPTURE_ID });

    for (const action of alreadyUploadedActions(CAPTURE_ID, {
      outcome: "alreadyUploaded",
      mediaId: "media_1",
      state: "approved",
    })) {
      queue = uploadReducer(queue, action);
    }

    expect(findItem(queue, CAPTURE_ID)).toMatchObject({
      state: "uploaded",
      mediaState: "approved",
      message: "Already sent.",
      progress: 1,
      retryable: false,
    });
  });
});
