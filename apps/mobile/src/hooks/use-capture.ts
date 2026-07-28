/**
 * Taking a photo, from "the shutter fired" to "it is in the durable queue".
 *
 * One hook for both entry points — the camera and the library picker — because
 * everything between them is identical and the differences are two booleans
 * (`mediaSource`, and whether the source file is ours to delete). Writing it
 * twice is how the library path ends up not stripping metadata.
 *
 * The order matters:
 *
 * 1. **Check eligibility before encoding.** `checkGrantEligibility` is the
 *    contract's own function, the same one `media.requestUploadGrant` runs
 *    server-side. Asking it first means a guest whose host has paused the party
 *    is told so immediately, rather than after eight seconds of JPEG encoding —
 *    and it is the gate that enforces the per-event library-import permission on
 *    the client as well as the server.
 * 2. **Encode, which strips the metadata** (see `../upload/media-pipeline`).
 * 3. **Check the size** against the same contract function, now that there is a
 *    real byte count to check. A 20 MB cap cannot be applied to a frame that has
 *    not been encoded yet.
 * 4. **Enqueue**, which starts the undo countdown.
 *
 * Nothing here throws at a screen: every failure comes back as a sentence.
 */

import { checkGrantEligibility } from "@partybooth/contracts/upload";
import { useCallback, useState } from "react";

import { captureHandledError } from "../lib/sentry";
import { buildPhotoCapture, type SourceImage } from "../upload/media-pipeline";
import { useUploadQueue } from "../upload/queue-provider";

import type { EventSummary } from "../lib/api";
import type { QueueItem } from "../upload/types";

export type CaptureOutcome =
  | { readonly status: "queued"; readonly item: QueueItem }
  | { readonly status: "refused"; readonly message: string };

export interface CaptureRequest {
  readonly source: SourceImage;
  readonly fromLibrary: boolean;
  /** When the shutter fired, if the camera told us. Defaults to now. */
  readonly capturedAt?: number | undefined;
}

const NO_EVENT_MESSAGE = "Join a party first — there's nowhere to send this yet.";
const PIPELINE_FAILED_MESSAGE =
  "That photo couldn't be prepared. Try taking it again; if it keeps happening, restart the app.";

export interface CaptureController {
  /** True while a frame is being encoded. The shutter disables itself on it. */
  readonly busy: boolean;
  readonly capture: (request: CaptureRequest) => Promise<CaptureOutcome>;
}

export function useCapture(event: EventSummary | null): CaptureController {
  const { enqueue } = useUploadQueue();
  const [busy, setBusy] = useState(false);

  const capture = useCallback(
    async (request: CaptureRequest): Promise<CaptureOutcome> => {
      if (event === null) return { status: "refused", message: NO_EVENT_MESSAGE };

      const mediaSource = request.fromLibrary ? "library" : "capture";

      // Before anything expensive. `byteSize: 1` is a placeholder for a file that
      // does not exist yet — the size is re-checked below with the real number.
      // What this call is actually for is the event state and the host's library
      // switch, both of which can refuse before a single pixel is decoded.
      const upfront = checkGrantEligibility({
        event: { state: event.state, allowLibraryImport: event.allowLibraryImport },
        mediaSource,
        file: { mediaType: "photo", byteSize: 1 },
      });
      if (!upfront.ok) return { status: "refused", message: upfront.message };

      setBusy(true);
      try {
        const draft = await buildPhotoCapture({
          eventId: event.id,
          source: request.source,
          mediaSource,
          capturedAt: request.capturedAt,
          // The camera's temp file is ours and is a duplicate the moment the
          // re-encode lands. A library pick is the guest's own photo.
          discardSource: !request.fromLibrary,
        });

        const sized = checkGrantEligibility({
          event: { state: event.state, allowLibraryImport: event.allowLibraryImport },
          mediaSource,
          file: {
            mediaType: draft.mediaType,
            byteSize: draft.byteSize,
            mimeType: draft.mimeType,
          },
        });
        if (!sized.ok) return { status: "refused", message: sized.message };

        return { status: "queued", item: enqueue(draft) };
      } catch (error) {
        // A failed encode is a device problem (out of storage, a corrupt frame),
        // not something a guest can be told anything useful about — so it goes to
        // Sentry and they get one sentence and a working shutter.
        captureHandledError(error, { scope: "capture.build", mediaSource });
        return { status: "refused", message: PIPELINE_FAILED_MESSAGE };
      } finally {
        setBusy(false);
      }
    },
    [event, enqueue],
  );

  return { busy, capture };
}
