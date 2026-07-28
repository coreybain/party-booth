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
  MEDIA_LIMITS,
  MEDIA_STATES,
  parseGrantResult,
  type EventState,
  type MediaSource,
  type MediaState,
} from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { newCaptureId } from "@/lib/upload/capture-id";
import { checksumOfBlob } from "@/lib/upload/checksum";
import {
  browserDerivativeRuntime,
  buildPhotoDerivatives,
  derivativeFileName,
  DerivativeError,
  planDerivatives,
} from "@/lib/upload/derivative";
import {
  emptyUploadQueue,
  findItem,
  releasePreview,
  uploadReducer,
  type CapturedPayload,
  type PendingDerivative,
  type UploadItem,
  type UploadQueue,
} from "@/lib/upload/machine";
import { PARTY_MEDIA_ROUTE, uploadFiles } from "@/lib/upload/uploader";
import { browserVideoRuntime, buildVideoFacts, posterFileName } from "@/lib/upload/video";

/**
 * A hard ceiling on what will be handed to a canvas.
 *
 * Not a policy — `MEDIA_LIMITS` is — but a guard against decoding something that
 * will take the browser tab down with it. Photos are re-encoded to 2560 px, so a
 * source larger than this is a video renamed, a RAW file, or a mistake, and none
 * of those get better for being decoded.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * How long to wait before retrying a derivative that arrived before its
 * original's completion callback did.
 *
 * `derivativeWithoutOriginal` is deliberately **not** a permanent rejection: the
 * two uploads are a few hundred milliseconds apart and the provider's callback
 * is a separate request that can lose the race. One retry, then let it go — a
 * capture with no preview is a working capture (ADR 0008), and a client that
 * keeps retrying for ever on a phone in a pocket is not.
 */
const DERIVATIVE_RETRY_DELAY_MS = 2_000;

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

      const isVideo = file.type.startsWith("video/");
      if (!isVideo && !file.type.startsWith("image/")) {
        setSelectionError("That file is not a photo or a video.");
        return;
      }
      if (!isVideo && file.size > MAX_SOURCE_BYTES) {
        setSelectionError("That file is too big for this phone to process.");
        return;
      }
      if (isVideo && file.size > MEDIA_LIMITS.video.maxBytes) {
        // Checked before the file is opened at all: a 400 MB clip that is going
        // to be refused anyway should cost nothing but a glance at `size`.
        setSelectionError(
          `Videos must be ${String(Math.round(MEDIA_LIMITS.video.maxBytes / (1024 * 1024)))} MB or smaller.`,
        );
        return;
      }

      setPreparing(true);
      try {
        const captureId = newCaptureId();
        const capture = isVideo
          ? await prepareVideo(file, captureId, source)
          : await preparePhoto(file, captureId, source);

        const eligibility = checkGrantEligibility({
          event: { state: event.state, allowLibraryImport: event.allowLibraryImport },
          mediaSource: source,
          file: {
            mediaType: capture.mediaType,
            byteSize: capture.byteSize,
            mimeType: capture.mimeType,
            ...(capture.durationSeconds === undefined
              ? {}
              : { durationSeconds: capture.durationSeconds }),
          },
          sourceMetadataStripped: capture.metadataStripped,
        });
        if (!eligibility.ok) {
          // The same sentence Convex would have returned, one round trip and one
          // re-encode earlier. `MEDIA_LIMITS` is consulted by both.
          if (capture.previewUrl !== undefined) URL.revokeObjectURL(capture.previewUrl);
          setSelectionError(eligibility.message);
          return;
        }

        dispatch({ type: "captured", capture });
      } catch (error) {
        setSelectionError(
          error instanceof DerivativeError || error instanceof Error
            ? error.message
            : "That file could not be prepared for upload.",
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

  /**
   * Send one derivative for a capture whose original has already landed.
   *
   * Its own grant, its own single use, its own much tighter cap — the spine is
   * the same one the original went through, which is the whole argument of ADR
   * 0008: derivatives ride the pipeline that is already tested rather than
   * getting a second, less examined path.
   *
   * The return value says only whether one retry is worth making. Everything
   * else is swallowed on purpose: nothing about a derivative is the guest's
   * problem, and a failure here costs a fellow guest a thumbnail, not the host
   * or the submitter the photograph.
   */
  const sendDerivative = useCallback(
    async (item: UploadItem, derivative: PendingDerivative): Promise<{ retry: boolean }> => {
      const key = `${item.captureId}:${derivative.fileRole}`;
      const aborter = new AbortController();
      aborters.current.set(key, aborter);

      try {
        const checksum = await checksumOfBlob(derivative.file);
        const grant = parseGrantResult(
          await requestGrant({
            eventId: event.eventId,
            captureId: item.captureId,
            mediaType: item.mediaType,
            fileRole: derivative.fileRole,
            byteSize: derivative.byteSize,
            mimeType: derivative.mimeType,
            checksum,
            mediaSource: item.mediaSource,
            /*
             * `true`, and unlike the original this is a precondition rather than
             * a record: Convex refuses a derivative grant that does not claim
             * the re-encode, because a derivative is the artefact third parties
             * are served. It is honest for both of ours — a preview comes out of
             * the same canvas as the photo, and a poster is a frame drawn onto
             * one, and a bitmap has nowhere to keep an EXIF block.
             */
            sourceMetadataStripped: true,
            capturedAt: item.createdAt,
          }),
        );

        if (aborter.signal.aborted) return { retry: false };
        if (grant.outcome === "throttled") return { retry: true };
        if (grant.outcome === "rejected") {
          // The only refusal worth a second go: the provider's completion
          // callback for the original has not reached Convex yet.
          return { retry: grant.reason === "derivativeWithoutOriginal" };
        }
        if (grantHasExpired(grant, Date.now())) return { retry: false };

        await uploadFiles(PARTY_MEDIA_ROUTE, {
          files: [derivative.file],
          signal: aborter.signal,
          input: buildUploadTicket(grant, {
            mimeType: derivative.mimeType,
            checksum,
            width: derivative.width,
            height: derivative.height,
          }),
        });
        return { retry: false };
      } catch {
        return { retry: false };
      } finally {
        aborters.current.delete(key);
      }
    },
    [event.eventId, requestGrant],
  );

  const sendDerivatives = useCallback(
    async (item: UploadItem): Promise<void> => {
      for (const derivative of item.derivatives) {
        const first = await sendDerivative(item, derivative);
        if (!first.retry) continue;
        await sleep(DERIVATIVE_RETRY_DELAY_MS);
        await sendDerivative(item, derivative);
      }
    },
    [sendDerivative],
  );

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
              // produced (ADR 0004 §7), not a literal `true`. It is `false` for
              // every video, because a browser cannot re-encode one.
              sourceMetadataStripped: item.metadataStripped,
              capturedAt: item.createdAt,
              ...(item.durationSeconds === undefined
                ? {}
                : { durationSeconds: item.durationSeconds }),
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
              // Carried through so the middleware's `validateMediaFile` has the
              // number, and so `completeUpload` can apply the 60-second cap to
              // the object that actually landed rather than to the estimate.
              durationSeconds: item.durationSeconds,
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

          // Fire-and-forget, and after the guest has already been told their
          // photo landed. A derivative is not a submission (ADR 0008): it moves
          // no state and no counter, so making the guest wait on it — or telling
          // them it failed — would be reporting an internal detail as an outcome.
          void sendDerivatives(item);
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
    [event.eventId, requestGrant, sendDerivatives],
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
/* Preparing a file                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A photo: re-encode, hash the re-encoded bytes, upload a preview, keep a
 * thumbnail.
 *
 * Three encodes, and the middle one is the point. The **uploaded `preview`
 * derivative** is the contract's `shared` tier — 1280 px, the same on both
 * clients — and it is what the moderation grid, the gallery and the slideshow
 * fetch instead of a 2560 px original, which is the difference between a laptop
 * scrolling two hundred cards and a laptop stalling on them.
 *
 * This used to be the 480 px local thumbnail doing double duty. That was cheap
 * and it was honest on privacy (it is a canvas re-encode either way, so the
 * derivative grant's claim held), but it meant a fellow guest on the web path
 * was served a 480 px image where the app served 1280 px, from the same
 * contract. The tier exists now, so the drift does not have to.
 *
 * Nobody loses resolution by any of this: a web photo's original *is* served, to
 * everyone, because the re-encode above means `mayServeOriginal` returns true.
 */
async function preparePhoto(
  file: File,
  captureId: string,
  source: MediaSource,
): Promise<CapturedPayload> {
  const derivatives = await buildPhotoDerivatives(file, browserDerivativeRuntime);
  const checksum = await checksumOfBlob(derivatives.upload);
  const sharedSize = planDerivatives(derivatives.sourceDimensions).shared;

  const preview: PendingDerivative = {
    fileRole: "preview",
    file: new File([derivatives.shared], derivativeFileName(captureId, "preview"), {
      type: derivatives.shared.type,
    }),
    byteSize: derivatives.shared.size,
    mimeType: derivatives.shared.type,
    width: sharedSize.width,
    height: sharedSize.height,
  };

  return {
    captureId,
    mediaType: "photo",
    mediaSource: source,
    file: new File([derivatives.upload], derivativeFileName(captureId, "original"), {
      type: derivatives.upload.type,
    }),
    byteSize: derivatives.upload.size,
    mimeType: derivatives.upload.type,
    checksum,
    metadataStripped: derivatives.metadataStripped,
    width: derivatives.dimensions.width,
    height: derivatives.dimensions.height,
    derivatives: [preview],
    // The local thumbnail, not the uploaded preview: this one only ever has to
    // fill a card on the guest's own screen while the bytes are in flight.
    previewUrl: URL.createObjectURL(derivatives.thumbnail),
    createdAt: Date.now(),
  };
}

/**
 * A video: read its length, take a poster, send the clip **unchanged**.
 *
 * `metadataStripped: false`, truthfully — there is no transcoder in a phone
 * browser, so the recording that came out of the camera is the recording that
 * goes to storage, and a client that claimed otherwise would be lying.
 *
 * Since Sprint 4 that claim has a second half (`MetadataClaim` in the contract),
 * and this path answers `false` to that one too. It is the honest answer and it
 * is where the web and the app genuinely differ: `apps/mobile` records through
 * its own camera in an app that ships no location permission, so it can promise
 * "carries no location" without promising a re-encode. A browser cannot. The
 * `input[capture]` element is a *request*, not a guarantee — every mobile OS
 * lets the guest pick an existing file from the same sheet — so a clip arriving
 * here may be one from the camera roll with a full GPS trace in it, and nothing
 * available in a browser can tell the difference.
 *
 * The consequence is exactly the one `mayServeOriginal` describes: the submitter
 * and the hosts can play the clip, and a fellow guest gets the poster instead.
 * The poster is the derivative that makes it visible to them at all, and it *is*
 * a canvas re-encode.
 *
 * The checksum is computed over the whole clip, which for a 200 MB recording is
 * a 200 MB read. Unavoidable: `uploadTicketSchema` requires it and it is what
 * binds these bytes to this grant. It is also why the size ceiling is checked
 * before this function is ever called.
 */
async function prepareVideo(
  file: File,
  captureId: string,
  source: MediaSource,
): Promise<CapturedPayload> {
  const facts = await buildVideoFacts(file, browserVideoRuntime, browserDerivativeRuntime);
  const checksum = await checksumOfBlob(file);

  const poster: PendingDerivative = {
    fileRole: "poster",
    file: new File([facts.poster], posterFileName(captureId), { type: facts.poster.type }),
    byteSize: facts.poster.size,
    mimeType: facts.poster.type,
    width: facts.posterDimensions.width,
    height: facts.posterDimensions.height,
  };

  return {
    captureId,
    mediaType: "video",
    mediaSource: source,
    file,
    byteSize: file.size,
    mimeType: file.type,
    checksum,
    metadataStripped: false,
    width: facts.dimensions.width,
    height: facts.dimensions.height,
    durationSeconds: facts.durationSeconds,
    derivatives: [poster],
    previewUrl: URL.createObjectURL(facts.poster),
    createdAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
