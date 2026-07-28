/**
 * The durable upload queue, wired to React, Convex and the filesystem.
 *
 * Everything that can be decided with numbers lives elsewhere and is unit-tested
 * (`./queue-reducer`, `./queue-engine`, `./countdown`, `./persistence`). What is
 * here is the part that cannot be: promises, timers, `AppState`, and the two
 * Convex mutations. Keeping the split sharp is what makes "does a failed upload
 * survive a force-quit and retry with the right backoff?" a test rather than a
 * ritual with aeroplane mode.
 *
 * ## The loop
 *
 * One item at a time, oldest first. Concurrency is deliberately 1: a party runs
 * on one saturated access point, and three parallel 4 MB uploads finish later
 * *and* in a worse order than three sequential ones — the host sees nothing for
 * ninety seconds instead of a photo every thirty.
 *
 * For each attempt: `media.requestUploadGrant` → transport → `media.confirmUpload`.
 * A refusal from the first is a **value**, not an exception (ADR 0004 §2), so
 * `readGrantResult` fans it back out into "wait this long" or "stop trying".
 *
 * ## Resume, in three places
 *
 * 1. **Cold start.** `hydrate` reads the file and rewrites anything left
 *    `uploading` back to `queued` — a request cannot outlive its process.
 * 2. **Foreground.** `AppState` → `resume` does the same for a request whose
 *    process survived a backgrounding but whose socket did not. iOS suspends a
 *    backgrounded app mid-transfer and what comes back is a promise that will
 *    never settle.
 * 3. **Every state change.** The effect below re-evaluates after each dispatch,
 *    so nothing waits for a timer that a re-render already made redundant.
 *
 * Background *retry* — uploading while the app is not on screen — is explicitly
 * out of scope for launch (PLAN.md: "background retry best-effort post-launch").
 * No background task is registered, and none should be added before the party.
 */

import { useMutation } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { derivativeFileName } from "@partybooth/contracts/capture";
import {
  buildUploadTicket,
  grantHasExpired,
  isPermanentRejection,
  parseGrantResult,
} from "@partybooth/contracts/upload";

import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { captureHandledError } from "../lib/sentry";

import {
  CAPTURE_SETTINGS_FILE_NAME,
  QUEUE_FILE_NAME,
  deleteLocalFile,
  readStoreFile,
  writeStoreFile,
} from "./device-store";
import { nextTask, nextWakeUpAt, readGrantResult } from "./queue-engine";
import {
  forgettableItems,
  itemsForEvent,
  localFilesOf,
  pendingCountForEvent,
  queueItemFromDraft,
  queueReducer,
  undoableItem,
} from "./queue-reducer";
import { parseQueue, serialiseQueue } from "./persistence";
import { nextReportedSet, queueReportsFor, type QueueReport } from "./queue-reporting";
import {
  DEFAULT_CAPTURE_SETTINGS,
  autoSendsFor,
  parseCaptureSettings,
  serialiseCaptureSettings,
  withAutoSend,
  withUndoDelay,
  type CaptureSettings,
} from "./settings";
import { createUploadThingTransport } from "./transport-uploadthing";
import { isUploadCancelled, type UploadTransport } from "./transport";
import { EMPTY_QUEUE, type CaptureDraft, type QueueDerivative, type QueueItem } from "./types";

import type { MediaFileRole, MediaSource, MediaType } from "@partybooth/contracts/media";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** How long a persisted write is coalesced for. Progress events are frequent. */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * How long terminal rows and their local files are kept.
 *
 * `uploaded` outlives the round trip so the Photos tab can draw the local
 * thumbnail while the server is still making its own derivative. `cancelled`
 * does not: an undone photo should stop existing promptly.
 */
const FORGET_POLICY = { uploadedKeepMs: 5 * 60_000, cancelledKeepMs: 5_000 } as const;

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export interface UploadQueueValue {
  /** Every capture on this device, across every party. */
  readonly items: readonly QueueItem[];
  /** False until the on-disk queue has been read. */
  readonly hydrated: boolean;
  /** True when the app has no backend and nothing can be sent. */
  readonly offline: boolean;

  readonly settings: CaptureSettings;
  readonly setAutoSend: (mediaType: MediaType, enabled: boolean) => void;
  readonly setUndoDelay: (delayMs: number) => void;

  /** Admit a finished derivative into the queue. Returns the row it created. */
  readonly enqueue: (draft: CaptureDraft) => QueueItem;
  /** Skip the rest of the undo window, or send something auto-send held back. */
  readonly sendNow: (captureId: string) => void;
  /** Inside the undo window. Deletes the files. */
  readonly undo: (captureId: string) => void;
  /** Anywhere else before it is `uploaded`. Aborts a request in flight. */
  readonly cancel: (captureId: string) => void;
  readonly retry: (captureId: string) => void;

  /** This party's captures, newest first. */
  readonly itemsFor: (eventId: string | null | undefined) => QueueItem[];
  /** The one the camera should offer an Undo button for. */
  readonly undoableFor: (eventId: string | null | undefined) => QueueItem | undefined;
  /** How many of this party's captures are still on their way. */
  readonly pendingFor: (eventId: string | null | undefined) => number;
}

const UploadQueueContext = createContext<UploadQueueValue | null>(null);

export function useUploadQueue(): UploadQueueValue {
  const value = useContext(UploadQueueContext);
  if (!value) {
    throw new Error("useUploadQueue must be used inside <UploadQueue> (see src/providers).");
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* The backend seam                                                           */
/* -------------------------------------------------------------------------- */

/** Exactly what `media.requestUploadGrant` is sent, per `uploadGrantRequestSchema`. */
export interface GrantArgs {
  /**
   * Convex requires anything crossing the wire as an argument object to carry
   * this. It is not an invitation to send extra fields — `uploadGrantRequestSchema`
   * on the far side rejects them.
   */
  readonly [key: string]: unknown;
  readonly eventId: string;
  readonly captureId: string;
  readonly mediaType: MediaType;
  /**
   * Which artefact of the capture this grant is for.
   *
   * Omitted means `original`, which is what every Sprint-3 call meant. A
   * derivative is a **separate grant under the same `captureId`**, held to its
   * own much tighter cap and refused outright unless `sourceMetadataStripped` is
   * `true` — on a derivative the claim is a precondition rather than a record,
   * because a derivative is what third parties are served (ADR 0008).
   */
  readonly fileRole?: MediaFileRole | undefined;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly capturedAt: number;
  readonly mediaSource: MediaSource;
  readonly sourceMetadataStripped: boolean;
  readonly durationSeconds?: number | undefined;
}

/**
 * The two Convex calls the engine makes.
 *
 * Passed in rather than called directly so the provider can be mounted in a
 * build with no Convex client at all — `useMutation` needs a provider above it,
 * and an app with no `EXPO_PUBLIC_CONVEX_URL` has none. `null` means the queue
 * still accepts, persists and shows captures; it just never tries to send them.
 *
 * It is also the seam the queue's own tests use: `UploadQueueProvider` takes
 * this and a `UploadTransport`, so the whole engine runs against two fakes.
 */
export interface UploadBackend {
  /**
   * Returns whatever Convex answered, unparsed. `@partybooth/backend/client-api`
   * *asserts* the shape of a call rather than checking it, so the queue re-parses
   * with `parseGrantResult` before branching — the repo's rule for anything a
   * client acts on, and here the action is "send this photo somewhere".
   */
  readonly requestGrant: (args: GrantArgs) => Promise<unknown>;
  readonly confirmUpload: (secret: string) => Promise<{ mediaId: string | null }>;
  /**
   * Tell the server the queue gave up on a capture, or got it through after all.
   *
   * Optional, because the queue works perfectly well without it — it is the
   * *notification* trigger, not part of uploading — and because leaving it out
   * is how the tests that predate push stay honest. When absent, nothing is
   * reported and nothing complains.
   */
  readonly reportQueueEvent?: (report: QueueReport) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export function UploadQueueProvider({
  backend,
  transport,
  children,
}: {
  readonly backend: UploadBackend | null;
  readonly transport: UploadTransport | null;
  readonly children: ReactNode;
}) {
  const [state, dispatch] = useReducer(queueReducer, EMPTY_QUEUE);
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_CAPTURE_SETTINGS);
  // Bumped by the wake-up timer so the scheduling effect re-runs on the clock as
  // well as on state changes.
  const [clock, setClock] = useState(0);

  /*
   * Mirrors of the two pieces of state the async engine reads. The loop runs
   * across awaits, so closing over the render-time value would have it deciding
   * what to upload next from a snapshot several dispatches out of date.
   *
   * Written in an effect, not during render. Under React 19 a render can be
   * started, thrown away and started again, and a ref assigned during a
   * discarded render would leave the engine holding state that was never
   * committed — a queue item that does not exist, or an undo delay the guest
   * never chose. The effect runs after commit, so the mirror only ever reflects
   * state that actually happened. This is also what the `react-hooks/refs` lint
   * rule is pointing at; the rule is right.
   *
   * Ordering is safe: this effect is declared above the scheduling effect, and
   * React runs effects in declaration order within a commit, so the pump never
   * reads a mirror from the previous commit.
   */
  const stateRef = useRef(state);
  const settingsRef = useRef(settings);

  useEffect(() => {
    stateRef.current = state;
    settingsRef.current = settings;
  }, [state, settings]);

  /** The one capture currently being attempted. Concurrency is deliberately 1. */
  const runningRef = useRef<string | null>(null);
  const abortsRef = useRef(new Map<string, AbortController>());

  /* ---------------------------------------------------------------- */
  /* Hydration                                                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [rawQueue, rawSettings] = await Promise.all([
        readStoreFile(QUEUE_FILE_NAME),
        readStoreFile(CAPTURE_SETTINGS_FILE_NAME),
      ]);
      if (cancelled) return;
      setSettings(parseCaptureSettings(rawSettings));
      dispatch({ type: "hydrate", items: parseQueue(rawQueue), now: Date.now() });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Persistence                                                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!state.hydrated) return;
    // Debounced: `uploadProgress` fires dozens of times per file, and
    // `File.write` is a synchronous native call. The queue is durable to the
    // last few hundred milliseconds, which is the right trade — the failure it
    // guards against is a force-quit, not a torn write.
    const timer = setTimeout(() => {
      void writeStoreFile(QUEUE_FILE_NAME, serialiseQueue(state.items));
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state.hydrated, state.items]);

  const persistSettings = useCallback((next: CaptureSettings) => {
    setSettings(next);
    void writeStoreFile(CAPTURE_SETTINGS_FILE_NAME, serialiseCaptureSettings(next));
  }, []);

  const setAutoSend = useCallback(
    (mediaType: MediaType, enabled: boolean) => {
      persistSettings(withAutoSend(settingsRef.current, mediaType, enabled));
    },
    [persistSettings],
  );

  const setUndoDelay = useCallback(
    (delayMs: number) => {
      persistSettings(withUndoDelay(settingsRef.current, delayMs));
    },
    [persistSettings],
  );

  /* ---------------------------------------------------------------- */
  /* One attempt                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Send one derivative of a capture that has already landed.
   *
   * Structurally the same three steps as {@link attempt} — grant, transport,
   * nothing — and deliberately *not* folded into it, because the differences are
   * the whole point:
   *
   * - It does **not** call `confirmUpload`. A derivative attaches a key and
   *   stops: no state change, no counter, no completion row, so one capture
   *   stays one submission whatever number of objects it arrives as. The
   *   provider callback is what registers it.
   * - It does **not** move the capture's state. The photograph is already in the
   *   party; whether its thumbnail made it is not something the guest is shown
   *   or asked about.
   * - It has no cancel. There is no affordance for one, so there is no
   *   `AbortController` to register.
   */
  const attemptDerivative = useCallback(
    async (item: QueueItem, derivative: QueueDerivative): Promise<void> => {
      if (backend === null || transport === null) return;

      dispatch({
        type: "derivativeStarted",
        captureId: item.captureId,
        role: derivative.role,
        now: Date.now(),
      });

      try {
        const answer = await backend.requestGrant({
          eventId: item.eventId,
          captureId: item.captureId,
          mediaType: item.mediaType,
          fileRole: derivative.role,
          byteSize: derivative.byteSize,
          mimeType: derivative.mimeType,
          checksum: derivative.checksum,
          capturedAt: item.capturedAt,
          mediaSource: item.mediaSource,
          // A precondition rather than a record here: the grant is refused
          // without it. Every derivative this app produces is a JPEG written
          // from decoded pixels, so it is earned in the strongest sense.
          sourceMetadataStripped: true,
          ...(derivative.durationSeconds === undefined
            ? {}
            : { durationSeconds: derivative.durationSeconds }),
        });

        const parsed = parseGrantResult(answer);
        if (parsed.outcome !== "granted") {
          const permanent =
            parsed.outcome === "rejected" ? isPermanentRejection(parsed.reason) : false;
          dispatch({
            type: "derivativeFailed",
            captureId: item.captureId,
            role: derivative.role,
            permanent,
            ...(parsed.outcome === "throttled" ? { retryAfterMs: parsed.retryAfterMs } : {}),
            now: Date.now(),
          });
          return;
        }

        if (grantHasExpired(parsed, Date.now())) {
          dispatch({
            type: "derivativeFailed",
            captureId: item.captureId,
            role: derivative.role,
            permanent: false,
            now: Date.now(),
          });
          return;
        }

        await transport.upload({
          file: {
            uri: derivative.uri,
            name: `${item.captureId}-${derivative.role}.jpg`,
            mimeType: derivative.mimeType,
            byteSize: derivative.byteSize,
          },
          ticket: buildUploadTicket(parsed, {
            mimeType: derivative.mimeType,
            checksum: derivative.checksum,
            width: derivative.width,
            height: derivative.height,
            durationSeconds: derivative.durationSeconds,
          }),
        });

        dispatch({
          type: "derivativeSucceeded",
          captureId: item.captureId,
          role: derivative.role,
          now: Date.now(),
        });
      } catch (error) {
        // Not reported to Sentry at `error` level and not shown to the guest: a
        // thumbnail that did not upload is not an incident, and there is nothing
        // for them to do about it. The breadcrumb is enough to notice a pattern.
        captureHandledError(error, { scope: "upload.derivative", role: derivative.role });
        const copy = describeError(error);
        dispatch({
          type: "derivativeFailed",
          captureId: item.captureId,
          role: derivative.role,
          permanent: copy.recovery === "none" || copy.recovery === "signIn",
          ...(copy.retryAfterMs === undefined ? {} : { retryAfterMs: copy.retryAfterMs }),
          now: Date.now(),
        });
      }
    },
    [backend, transport],
  );

  const attempt = useCallback(
    async (item: QueueItem): Promise<void> => {
      if (backend === null || transport === null) return;

      dispatch({ type: "uploadStarted", captureId: item.captureId, now: Date.now() });

      const controller = new AbortController();
      abortsRef.current.set(item.captureId, controller);

      try {
        const answer = await backend.requestGrant({
          eventId: item.eventId,
          captureId: item.captureId,
          mediaType: item.mediaType,
          byteSize: item.byteSize,
          mimeType: item.mimeType,
          checksum: item.checksum,
          capturedAt: item.capturedAt,
          mediaSource: item.mediaSource,
          sourceMetadataStripped: item.sourceMetadataStripped,
          // Only sent when the client means something different by it than by
          // the re-encode claim — i.e. the video path. Omitted, the server reads
          // it as "same as the re-encode claim".
          ...(item.sourceCarriesNoLocation === undefined
            ? {}
            : { sourceCarriesNoLocation: item.sourceCarriesNoLocation }),
          ...(item.durationSeconds === undefined ? {} : { durationSeconds: item.durationSeconds }),
        });

        // Fails closed: an answer that is not one of the three documented
        // outcomes throws into the catch below and is treated as a retryable
        // failure, rather than being read as a grant it is not.
        const outcome = readGrantResult(parseGrantResult(answer));
        if (outcome.kind === "failed") {
          dispatch({
            type: "uploadFailed",
            captureId: item.captureId,
            failure: outcome.failure,
            retryAfterMs: outcome.retryAfterMs,
            now: Date.now(),
          });
          return;
        }

        /*
         * The grant's two minutes ran out between asking and sending. It is a
         * short window here — the request above is the line before — but reading
         * a 15 MB file off a slow device to build the upload body is inside it,
         * and asking for a fresh grant is instant while discovering a dead one
         * from a rejected upload is a round trip and a scary error.
         *
         * Retryable on purpose: the very next attempt mints a new grant.
         */
        if (grantHasExpired(outcome.grant, Date.now())) {
          dispatch({
            type: "uploadFailed",
            captureId: item.captureId,
            failure: { message: "That took too long to start. Trying again.", permanent: false },
            now: Date.now(),
          });
          return;
        }

        await transport.upload({
          file: {
            uri: item.uri,
            // Named from the capture id, never from the camera's own filename —
            // a library import would otherwise carry the guest's file naming
            // (and sometimes a date) into somebody else's storage.
            name: derivativeFileName(item.captureId, "original"),
            mimeType: item.mimeType,
            byteSize: item.byteSize,
          },
          // Built by the contract from the grant, so the ticket describes the
          // file that was actually authorised and not this row's own copy of
          // those facts. `apps/web`'s middleware parses the same schema.
          ticket: buildUploadTicket(outcome.grant, {
            mimeType: item.mimeType,
            checksum: item.checksum,
            width: item.width,
            height: item.height,
            durationSeconds: item.durationSeconds,
          }),
          signal: controller.signal,
          onProgress: (fraction) => {
            dispatch({ type: "uploadProgress", captureId: item.captureId, progress: fraction });
          },
        });

        // The client half of the two-sided completion (ADR 0004 §3). It creates
        // the media row if the provider's callback has not arrived yet, which is
        // what lets the spinner stop without waiting on a US-East↔pdx1 hop.
        const confirmation = await backend.confirmUpload(outcome.grant.secret);
        dispatch({
          type: "uploadSucceeded",
          captureId: item.captureId,
          mediaId: confirmation.mediaId,
          now: Date.now(),
        });
      } catch (error) {
        if (isUploadCancelled(error)) {
          // The guest pressed cancel. The reducer has already moved the row;
          // this is just the request unwinding, and it is not a failure.
          return;
        }
        captureHandledError(error, { scope: "upload.attempt" });
        const copy = describeError(error);
        dispatch({
          type: "uploadFailed",
          captureId: item.captureId,
          failure: {
            message: copy.message,
            // "Not allowed", "not found", "account locked" and "sign in again"
            // are not fixed by a timer. Everything else is worth another go.
            permanent: copy.recovery === "none" || copy.recovery === "signIn",
          },
          retryAfterMs: copy.retryAfterMs,
          now: Date.now(),
        });
      } finally {
        abortsRef.current.delete(item.captureId);
      }
    },
    [backend, transport],
  );

  /* ---------------------------------------------------------------- */
  /* The pump                                                         */
  /* ---------------------------------------------------------------- */

  const pump = useCallback(async () => {
    if (runningRef.current !== null) return;
    if (backend === null || transport === null) return;
    if (!stateRef.current.hydrated) return;

    const task = nextTask(stateRef.current.items, Date.now());
    if (task === undefined) return;

    // Concurrency stays 1 across *both* kinds of work, so a derivative can never
    // be sent at the same time as a photograph and steal its bandwidth.
    runningRef.current = task.item.captureId;
    try {
      if (task.kind === "original") await attempt(task.item);
      else await attemptDerivative(task.item, task.derivative);
    } finally {
      runningRef.current = null;
      // Dispatches inside `attempt` re-run the scheduling effect, which calls
      // back in here; nudging the clock covers the case where the state did not
      // change (a no-op transition) but the queue still has work.
      setClock((value) => value + 1);
    }
  }, [attempt, attemptDerivative, backend, transport]);

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                       */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!state.hydrated) return;
    const now = Date.now();

    // Close any undo window that has elapsed first; the resulting state change
    // brings this effect straight back with something runnable.
    if (
      state.items.some((item) => item.state === "captured" && item.autoSend && now >= item.sendAt)
    ) {
      dispatch({ type: "tick", now });
      return;
    }

    void pump();

    const wakeAt = nextWakeUpAt(state.items, now);
    if (wakeAt === null) return;
    // A floor keeps a zero-length undo delay from spinning the effect; a ceiling
    // keeps a long backoff from relying on a timer the OS may not honour after a
    // suspension — the foreground listener covers that case anyway.
    const delay = Math.min(Math.max(wakeAt - now, 50), 30_000);
    const timer = setTimeout(() => setClock((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [state, clock, pump]);

  /* ---------------------------------------------------------------- */
  /* Foreground resume                                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      dispatch({ type: "resume", now: Date.now() });
      setClock((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  /* ---------------------------------------------------------------- */
  /* Reporting failures and recoveries                                */
  /* ---------------------------------------------------------------- */

  /**
   * Captures a `failed` report has been sent for and not yet recovered.
   *
   * In memory rather than on disk, deliberately. The backend already dedupes on
   * its own throttle row, so a relaunch that re-reports a still-failed capture
   * notifies nobody twice; and the alternative — persisting this — means a
   * force-quit between the write and the send loses the pairing in the *other*
   * direction, where a recovery is never announced because the failure appears
   * never to have happened.
   */
  const reportedRef = useRef<ReadonlySet<string>>(new Set<string>());

  useEffect(() => {
    if (!state.hydrated) return;
    const report = backend?.reportQueueEvent;
    if (report === undefined) return;

    const due = queueReportsFor(state.items, reportedRef.current);
    // Applied before the awaits, not after. Two commits can land while a report
    // is in flight, and a set updated on completion would send the same "your
    // upload didn't send" three times.
    reportedRef.current = nextReportedSet(reportedRef.current, due, state.items);
    if (due.length === 0) return;

    void (async () => {
      for (const item of due) {
        try {
          await report(item);
        } catch (error) {
          // A notification nobody gets is not worth a failed upload's worth of
          // noise, and the queue itself is unaffected either way.
          captureHandledError(error, { scope: "upload.reportQueueEvent", event: item.event });
        }
      }
    })();
  }, [backend, state.hydrated, state.items]);

  /* ---------------------------------------------------------------- */
  /* Sweeping terminal rows                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!state.hydrated) return;
    const stale = forgettableItems(state.items, Date.now(), FORGET_POLICY);
    if (stale.length === 0) return;

    // Files first, row second. The other order would leave a file with nothing
    // naming it — an orphan no later sweep could recognise. `localFilesOf`
    // deduplicates, which matters for a video whose poster is also its local
    // thumbnail and for a capture whose poster could not be made at all (there
    // `previewUri === uri`).
    void (async () => {
      for (const item of stale) {
        for (const uri of localFilesOf(item)) await deleteLocalFile(uri);
      }
      dispatch({ type: "forget", captureIds: stale.map((item) => item.captureId) });
    })();
  }, [state.hydrated, state.items]);

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const enqueue = useCallback((draft: CaptureDraft): QueueItem => {
    const item = queueItemFromDraft(
      draft,
      {
        autoSend: autoSendsFor(settingsRef.current, draft.mediaType),
        undoDelayMs: settingsRef.current.undoDelayMs,
      },
      Date.now(),
    );
    dispatch({ type: "enqueue", item });
    setClock((value) => value + 1);
    return item;
  }, []);

  const sendNow = useCallback((captureId: string) => {
    dispatch({ type: "send", captureId, now: Date.now() });
    setClock((value) => value + 1);
  }, []);

  /** Abort anything in flight for this capture, then let the reducer move it. */
  const stop = useCallback((captureId: string) => {
    abortsRef.current.get(captureId)?.abort();
    abortsRef.current.delete(captureId);
  }, []);

  const undo = useCallback(
    (captureId: string) => {
      stop(captureId);
      dispatch({ type: "undo", captureId, now: Date.now() });
    },
    [stop],
  );

  const cancel = useCallback(
    (captureId: string) => {
      stop(captureId);
      dispatch({ type: "cancel", captureId, now: Date.now() });
    },
    [stop],
  );

  const retry = useCallback((captureId: string) => {
    dispatch({ type: "retry", captureId, now: Date.now() });
    setClock((value) => value + 1);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Assembled value                                                  */
  /* ---------------------------------------------------------------- */

  const value = useMemo<UploadQueueValue>(
    () => ({
      items: state.items,
      hydrated: state.hydrated,
      offline: backend === null || transport === null,
      settings,
      setAutoSend,
      setUndoDelay,
      enqueue,
      sendNow,
      undo,
      cancel,
      retry,
      itemsFor: (eventId) => itemsForEvent(state.items, eventId),
      undoableFor: (eventId) => undoableItem(state.items, eventId),
      pendingFor: (eventId) => pendingCountForEvent(state.items, eventId),
    }),
    [
      state.items,
      state.hydrated,
      backend,
      transport,
      settings,
      setAutoSend,
      setUndoDelay,
      enqueue,
      sendNow,
      undo,
      cancel,
      retry,
    ],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The provider with Convex attached. Mounted only inside the configured tree.
 *
 * Split out so that a build with no backend never calls `useMutation`, which
 * needs a `ConvexProvider` above it and would throw during the first render of a
 * fresh checkout.
 */
export function ConnectedUploadQueue({
  siteUrl,
  children,
}: {
  readonly siteUrl: string;
  readonly children: ReactNode;
}) {
  const requestUploadGrant = useMutation(api.media.requestUploadGrant);
  const confirmUpload = useMutation(api.media.confirmUpload);
  const reportUploadQueue = useMutation(api.push.reportUploadQueue);

  const backend = useMemo<UploadBackend>(
    () => ({
      requestGrant: (args) => requestUploadGrant(args),
      confirmUpload: async (secret) => {
        const result = await confirmUpload({ secret });
        return { mediaId: result.mediaId };
      },
      reportQueueEvent: async (report) => {
        await reportUploadQueue({
          eventId: report.eventId,
          captureId: report.captureId,
          event: report.event,
          attempts: report.attempts,
        });
      },
    }),
    [requestUploadGrant, confirmUpload, reportUploadQueue],
  );

  const transport = useMemo(() => createUploadThingTransport({ siteUrl }), [siteUrl]);

  return (
    <UploadQueueProvider backend={backend} transport={transport}>
      {children}
    </UploadQueueProvider>
  );
}

/** The provider with nothing attached — captures are kept, never sent. */
export function OfflineUploadQueue({ children }: { readonly children: ReactNode }) {
  return (
    <UploadQueueProvider backend={null} transport={null}>
      {children}
    </UploadQueueProvider>
  );
}
