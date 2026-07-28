"use client";

/**
 * The guest capture controller — one photo, from "chosen" to "waiting for the
 * host", including everything that can go wrong on the way.
 *
 * This is the party-critical path in PLAN.md: the web guest journey is the
 * *guaranteed* one for 5 August, because App Review might not land. So the
 * ordering below is chosen for what a person standing in a loud room can
 * recover from, not for what is tidiest:
 *
 * 1. **Re-encode first, ask second.** The derivative is built and hashed before
 *    a grant is requested, because the grant is bound to `byteSize` and
 *    `checksum` and both are facts about the re-encoded frame. Requesting first
 *    would mint a two-minute capability and then spend ninety seconds of it
 *    decoding a 48-megapixel HEIC.
 * 2. **Refusals are values.** `media.requestUploadGrant` returns
 *    `{ outcome: "rejected" | "throttled" }` rather than throwing, and every one
 *    of those sentences is written for the guest by
 *    `@partybooth/contracts/upload`. Nothing here rewrites them.
 * 3. **Retry keeps the capture id.** A retry re-sends the same bytes under the
 *    same `captureId`, which is exactly what makes the pipeline idempotent — the
 *    stranded `processing` row from the failed attempt is the row the retry
 *    completes onto, rather than a second copy in the host's queue.
 *
 * All the interesting state lives in `uploadReducer`, which is pure and tested.
 * This hook is the part that talks to the network, and it is deliberately thin.
 */

import { useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { appErrorMessage } from "@/lib/app-errors";
import {
  buildUploadTicket,
  checkGrantEligibility,
  grantHasExpired,
  isPermanentRejection,
  MEDIA_STATES,
  parseGrantResult,
  type EventState,
  type MediaSource,
  type MediaState,
  type MediaType,
} from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { newCaptureId } from "@/lib/upload/capture-id";
import { checksumOfBlob } from "@/lib/upload/checksum";
import {
  browserDerivativeRuntime,
  buildPhotoDerivatives,
  derivativeFileName,
  DerivativeError,
} from "@/lib/upload/derivative";
import {
  emptyUploadQueue,
  findItem,
  releasePreview,
  uploadReducer,
  type UploadItem,
  type UploadQueue,
} from "@/lib/upload/machine";
import { PARTY_MEDIA_ROUTE, uploadFiles } from "@/lib/upload/uploader";

/**
 * A hard ceiling on what will be handed to a canvas.
 *
 * Not a policy — `MEDIA_LIMITS` is — but a guard against decoding something that
 * will take the browser tab down with it. Photos are re-encoded to 2560 px, so a
 * source larger than this is a video renamed, a RAW file, or a mistake, and none
 * of those get better for being decoded.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface CaptureEventContext {
  readonly eventId: string;
  readonly state: EventState;
  readonly allowLibraryImport: boolean;
}

export interface CaptureController {
  readonly queue: UploadQueue;
  /** Set while a chosen file is being re-encoded and hashed. */
  readonly preparing: boolean;
  /** A failure that belongs to the picker, not to any one queued item. */
  readonly selectionError: string | undefined;
  readonly select: (file: File, source: MediaSource) => Promise<void>;
  readonly send: (captureId: string) => Promise<void>;
  readonly cancel: (captureId: string) => void;
  readonly discard: (captureId: string) => void;
  readonly clearSelectionError: () => void;
}

export function useCaptureUpload(event: CaptureEventContext): CaptureController {
  const [queue, dispatch] = useReducer(uploadReducer, emptyUploadQueue);
  const requestGrant = useMutation(backendApi.media.requestUploadGrant);

  /*
   * `send` needs the current item without depending on `queue`, or every
   * progress tick would rebuild the callback and the in-flight upload would be
   * holding a stale closure. A ref mirroring the reducer is the standard shape;
   * it is written in an effect rather than during render, because a ref written
   * mid-render is invisible to React and wrong under concurrent rendering.
   *
   * Every reader is an event handler or a cleanup — "the guest tapped Send",
   * "the component went away" — all of which run after the commit that updated
   * it, so the one-commit lag is not observable.
   */
  const queueRef = useRef<UploadQueue>(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const aborters = useRef(new Map<string, AbortController>());
  const [preparing, setPreparing] = useState(false);
  const [selectionError, setSelectionError] = useState<string | undefined>(undefined);

  /* ---------------------------------------------------------------------- */
  /* Choosing a photo                                                       */
  /* ---------------------------------------------------------------------- */

  const select = useCallback(
    async (file: File, source: MediaSource): Promise<void> => {
      setSelectionError(undefined);

      if (!file.type.startsWith("image/")) {
        // Video capture is Sprint 4. The *pipeline* takes video already — the
        // route, the grant and the media row are all type-agnostic — but there
        // is no duration probe on this screen yet, and a video without one is a
        // grant Convex will refuse.
        setSelectionError("Photos only for now — video is coming.");
        return;
      }
      if (file.size > MAX_SOURCE_BYTES) {
        setSelectionError("That file is too big for this phone to process.");
        return;
      }

      setPreparing(true);
      try {
        const derivatives = await buildPhotoDerivatives(file, browserDerivativeRuntime);
        const checksum = await checksumOfBlob(derivatives.upload);
        const captureId = newCaptureId();
        const mediaType: MediaType = "photo";

        const eligibility = checkGrantEligibility({
          event: { state: event.state, allowLibraryImport: event.allowLibraryImport },
          mediaSource: source,
          file: {
            mediaType,
            byteSize: derivatives.upload.size,
            mimeType: derivatives.upload.type,
          },
        });
        if (!eligibility.ok) {
          // The same sentence Convex would have returned, one round trip and one
          // re-encode earlier. `MEDIA_LIMITS` is consulted by both.
          setSelectionError(eligibility.message);
          return;
        }

        dispatch({
          type: "captured",
          capture: {
            captureId,
            mediaType,
            mediaSource: source,
            file: new File([derivatives.upload], derivativeFileName(captureId), {
              type: derivatives.upload.type,
            }),
            byteSize: derivatives.upload.size,
            mimeType: derivatives.upload.type,
            checksum,
            metadataStripped: derivatives.metadataStripped,
            width: derivatives.dimensions.width,
            height: derivatives.dimensions.height,
            previewUrl: URL.createObjectURL(derivatives.preview),
            createdAt: Date.now(),
          },
        });
      } catch (error) {
        setSelectionError(
          error instanceof DerivativeError || error instanceof Error
            ? error.message
            : "That photo could not be prepared for upload.",
        );
      } finally {
        setPreparing(false);
      }
    },
    [event.allowLibraryImport, event.state],
  );

  /* ---------------------------------------------------------------------- */
  /* Sending it                                                             */
  /* ---------------------------------------------------------------------- */

  const send = useCallback(
    async (captureId: string): Promise<void> => {
      const item = findItem(queueRef.current, captureId);
      if (item === undefined) return;
      if (item.state !== "captured" && item.state !== "failed") return;

      /*
       * The aborter is registered **before** the grant request, not after it.
       *
       * "Cancel" is offered from `queued`, and the grant round trip is the slow
       * part of this on party wifi — so an aborter created only once bytes start
       * moving leaves a window in which the guest taps Cancel, the reducer
       * records it, and the upload carries on to completion behind a UI that
       * says it stopped. Every exit below goes through the `finally`, so nothing
       * is left in the map.
       */
      const aborter = new AbortController();
      aborters.current.set(captureId, aborter);
      dispatch({ type: "queued", captureId });

      try {
        let grant;
        try {
          grant = parseGrantResult(
            await requestGrant({
              eventId: event.eventId,
              captureId,
              mediaType: item.mediaType,
              byteSize: item.byteSize,
              mimeType: item.mimeType,
              checksum: item.checksum,
              mediaSource: item.mediaSource,
              // Recorded, never assumed: this is the value the pipeline actually
              // produced (ADR 0004 §7), not a literal `true`.
              sourceMetadataStripped: item.metadataStripped,
              capturedAt: item.createdAt,
            }),
          );
        } catch (error) {
          if (aborter.signal.aborted) return;
          dispatch({ type: "failed", captureId, message: appErrorMessage(error), retryable: true });
          return;
        }

        // Cancelled while the grant was in flight. The grant is left to expire
        // on its own two-minute clock rather than being handed back: there is no
        // "return a grant" call, and inventing one would be a second way to
        // reach a capability that already has exactly one.
        if (aborter.signal.aborted) {
          dispatch({ type: "cancelled", captureId });
          return;
        }

        if (grant.outcome === "throttled") {
          dispatch({ type: "failed", captureId, message: grant.message, retryable: true });
          return;
        }

        if (grant.outcome === "rejected") {
          if (grant.reason === "duplicateCapture") {
            /*
             * This photo is already on the server. The overwhelmingly likely
             * cause is the previous attempt succeeding and its *response* being
             * lost, which on a phone is indistinguishable from a failure.
             * Showing it as sent is both true and the only answer that does not
             * invite the guest to keep pressing a button that cannot work.
             */
            dispatch({ type: "uploaded", captureId, message: "Already sent." });
            return;
          }
          /*
           * Whether a retry can help is the contract's call, not this hook's,
           * and `apps/mobile` asks the same function. The one that matters at a
           * real party is `eventNotAcceptingUploads`: a host pauses the queue to
           * catch up on moderation and un-pauses two minutes later, so that
           * refusal keeps its retry button while "that video is too long" does
           * not.
           */
          dispatch({
            type: "failed",
            captureId,
            message: grant.message,
            retryable: !isPermanentRejection(grant.reason),
          });
          return;
        }

        if (grantHasExpired(grant, Date.now())) {
          dispatch({
            type: "failed",
            captureId,
            message: "That took too long to start. Try again.",
            retryable: true,
          });
          return;
        }

        dispatch({ type: "uploadStarted", captureId });

        try {
          const [uploaded] = await uploadFiles(PARTY_MEDIA_ROUTE, {
            files: [item.file],
            signal: aborter.signal,
            // Built by the contract, not assembled here: `eventId`, `captureId`,
            // `mediaType` and `byteSize` come off the grant, so a ticket can
            // never describe a different file from the one that was authorised.
            input: buildUploadTicket(grant, {
              mimeType: item.mimeType,
              checksum: item.checksum,
              width: item.width,
              height: item.height,
            }),
            onUploadProgress: ({ progress }) => {
              // UploadThing reports 0–100; the reducer speaks 0–1.
              dispatch({ type: "progress", captureId, progress: progress / 100 });
            },
          });

          const state = uploaded?.serverData?.state;
          dispatch({
            type: "uploaded",
            captureId,
            ...(isMediaState(state) ? { mediaState: state } : {}),
          });
        } catch (error) {
          if (aborter.signal.aborted) {
            dispatch({ type: "cancelled", captureId });
            return;
          }
          dispatch({
            type: "failed",
            captureId,
            message: uploadFailureMessage(error),
            retryable: true,
          });
        }
      } finally {
        aborters.current.delete(captureId);
      }
    },
    [event.eventId, requestGrant],
  );

  /* ---------------------------------------------------------------------- */
  /* Taking it back                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Stop the transfer **and** say so immediately.
   *
   * Both halves matter and they fail differently. Aborting without dispatching
   * leaves the row saying "Starting…" until the in-flight call resolves, which
   * during the grant round trip is seconds — a Cancel button that appears to do
   * nothing gets pressed again. Dispatching without aborting leaves the UI
   * claiming it stopped while the bytes keep going.
   *
   * The later `cancelled` dispatch from inside `send` is then a same-state
   * no-op, and the `uploadStarted` that a raced grant would otherwise cause is
   * refused outright, because `cancelled` is terminal.
   */
  const cancel = useCallback((captureId: string): void => {
    aborters.current.get(captureId)?.abort();
    dispatch({ type: "cancelled", captureId });
  }, []);

  const discard = useCallback((captureId: string): void => {
    const item = findItem(queueRef.current, captureId);
    if (item !== undefined) releasePreview(item);
    dispatch({ type: "forget", captureId });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Cleanup                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const aborterMap = aborters.current;
    const held = queueRef;
    return () => {
      for (const aborter of aborterMap.values()) aborter.abort();
      for (const item of held.current.items) releasePreview(item);
    };
  }, []);

  const clearSelectionError = useCallback((): void => {
    setSelectionError(undefined);
  }, []);

  return useMemo(
    () => ({
      queue,
      preparing,
      selectionError,
      select,
      send,
      cancel,
      discard,
      clearSelectionError,
    }),
    [cancel, clearSelectionError, discard, preparing, queue, select, selectionError, send],
  );
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isMediaState(value: unknown): value is MediaState {
  return typeof value === "string" && (MEDIA_STATES as readonly string[]).includes(value);
}

/**
 * One sentence for an upload that did not finish.
 *
 * The provider's own errors are engineer-facing ("Failed to upload file to
 * storage provider"), and the guest reading them is holding a phone at a party.
 * `appErrorMessage` already knows how to say "you look offline"; anything else
 * gets the retryable sentence, because the button next to it is "Try again".
 */
function uploadFailureMessage(error: unknown): string {
  if (error instanceof Error && /abort/i.test(error.message)) return "Upload cancelled.";
  const message = appErrorMessage(error);
  return message.length > 0 ? message : "That did not send. Try again.";
}

export type { UploadItem, UploadQueue, MediaSource };
