/**
 * The client-side upload queue, as a pure reducer.
 *
 * Everything the guest capture screen shows about an in-flight photo — the
 * progress bar, the retry button, whether "Send" is still available — is derived
 * from this state, and none of it touches the network. That separation is what
 * makes the party-critical path testable offline: the reducer is the thing with
 * the interesting edge cases (a progress event arriving after a cancel, a retry
 * of something that already succeeded), and the hook around it is plumbing.
 *
 * **The states are the contract's, not this file's.** `CAPTURE_STATES` and
 * `captureStateMachine` live in `@partybooth/contracts/media` because
 * `apps/mobile` runs the same lifecycle, and a queue that invents its own
 * vocabulary is a queue whose "failed" means something subtly different from the
 * app's. Every move below goes through `captureStateMachine.canTransition`, so
 * an illegal transition is impossible rather than merely unlikely — and an
 * action that would make one is **ignored**, not thrown, because the actions
 * that arrive late (a progress tick after a cancel) are normal on a phone, not
 * faults.
 *
 * Web sends as soon as preparation finishes. `captured` is therefore a short
 * hand-off state between building the exact bytes and the upload controller
 * requesting a grant; it remains explicit because retries and late network
 * actions still need the shared capture state machine to reject illegal moves.
 */

import {
  captureStateMachine,
  isCaptureInFlight,
  isTerminalCapture,
  type CaptureState,
  type DerivativeFileRole,
  type MediaSource,
  type MediaState,
  type MediaType,
} from "@/lib/contracts";

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A second (or third) file for the same capture, waiting for the original to
 * land.
 *
 * It rides on the queue item rather than in its own queue because it is not a
 * submission: it never settles the media row, never moves a counter and never
 * shows the guest anything (ADR 0008). A capture whose derivative never arrives
 * is a capture that works — the host and the submitter see the original either
 * way, and what a missing preview costs is visibility to fellow guests.
 *
 * `durationSeconds` is deliberately absent from the type. A poster is a still
 * frame and has none, and a video's preview *clip* is not producible in a
 * browser (see `upload/video.ts`), so no derivative this client sends has one.
 */
export interface PendingDerivative {
  readonly fileRole: DerivativeFileRole;
  readonly file: File;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * One photo on its way out.
 *
 * `file` is the re-encoded derivative, not what the camera produced — the
 * original is never held anywhere, which is the point of ADR 0004 §7. Keeping
 * it on the item is what makes retry free: a failed upload retries the exact
 * bytes the grant was minted for, so the checksum still matches.
 */
export interface UploadItem {
  readonly captureId: string;
  readonly state: CaptureState;
  readonly mediaType: MediaType;
  /** Camera or photo roll. Gated per event by `allowLibraryImport`. */
  readonly mediaSource: MediaSource;
  readonly file: File;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly metadataStripped: boolean;
  readonly width?: number;
  readonly height?: number;
  /**
   * Required for a video's original — `validateMediaFile` refuses a grant
   * without one — and never set for a photo.
   */
  readonly durationSeconds?: number;
  /** Sent after the original lands, best-effort. Empty for most captures. */
  readonly derivatives: readonly PendingDerivative[];
  /** Object URL of the local thumbnail. Revoked when the item is forgotten. */
  readonly previewUrl?: string;
  /** 0–1. Only meaningful while `uploading`. */
  readonly progress: number;
  /** Why it failed, or what the server said. One sentence, shown as-is. */
  readonly message?: string;
  /** Whether offering a retry would be honest. A rejected grant is not retryable. */
  readonly retryable: boolean;
  /** Where the server put it, once it said. */
  readonly mediaState?: MediaState;
  readonly createdAt: number;
  /** How many times the guest has asked us to try again. */
  readonly attempts: number;
}

export interface UploadQueue {
  /** Newest first — the photo just taken is the one being looked at. */
  readonly items: readonly UploadItem[];
}

export const emptyUploadQueue: UploadQueue = { items: [] };

/** Captures the controller should start automatically, without retrying failures. */
export function capturedCaptureIds(queue: UploadQueue): readonly string[] {
  return queue.items.filter((item) => item.state === "captured").map((item) => item.captureId);
}

/**
 * Both predicates come from `@partybooth/contracts/media`, where they are
 * derived from the capture state machine's own transition table and shared with
 * `apps/mobile`. `isSettled` keeps its local name because that is what the
 * reducer below reads like; it is `isTerminalCapture` underneath.
 */
const isSettled = isTerminalCapture;
const isInFlight = isCaptureInFlight;

export { isSettled, isInFlight };

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export interface CapturedPayload {
  readonly captureId: string;
  readonly mediaType: MediaType;
  readonly mediaSource: MediaSource;
  readonly file: File;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly metadataStripped: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly derivatives?: readonly PendingDerivative[];
  readonly previewUrl?: string;
  readonly createdAt: number;
}

export type UploadAction =
  /** A photo has been chosen, re-encoded and hashed. Ready for auto-send. */
  | { readonly type: "captured"; readonly capture: CapturedPayload }
  /** Auto-send started, or the guest re-queued a failed capture. */
  | { readonly type: "queued"; readonly captureId: string }
  /** A grant was issued and bytes are moving. */
  | { readonly type: "uploadStarted"; readonly captureId: string }
  | { readonly type: "progress"; readonly captureId: string; readonly progress: number }
  | {
      readonly type: "uploaded";
      readonly captureId: string;
      readonly mediaState?: MediaState;
      readonly message?: string;
    }
  | {
      readonly type: "failed";
      readonly captureId: string;
      readonly message: string;
      /** `false` for a refusal that trying again cannot change. */
      readonly retryable: boolean;
    }
  | { readonly type: "cancelled"; readonly captureId: string }
  /** Drop a settled item from the list. The server row is the record now. */
  | { readonly type: "forget"; readonly captureId: string }
  | { readonly type: "forgetSettled" };

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

export function uploadReducer(state: UploadQueue, action: UploadAction): UploadQueue {
  switch (action.type) {
    case "captured": {
      // Re-capturing an id that is already here is a no-op rather than a
      // replacement: ids are 128 random bits, so this only happens if a caller
      // dispatched twice, and silently swapping the file underneath an upload
      // in flight is how a checksum stops matching its grant.
      if (findItem(state, action.capture.captureId) !== undefined) return state;
      const item: UploadItem = {
        ...action.capture,
        derivatives: action.capture.derivatives ?? [],
        state: "captured",
        progress: 0,
        retryable: false,
        attempts: 0,
      };
      return { items: [item, ...state.items] };
    }

    case "queued":
      return transition(state, action.captureId, "queued", (item) => ({
        progress: 0,
        message: undefined,
        retryable: false,
        // Re-queuing from `failed` is a retry; from `captured` it is the first go.
        attempts: item.state === "failed" ? item.attempts + 1 : item.attempts,
      }));

    case "uploadStarted":
      return transition(state, action.captureId, "uploading", () => ({ progress: 0 }));

    case "progress":
      return patch(state, action.captureId, (item) =>
        // A tick that arrives after a cancel or a failure must not resurrect the
        // bar, and progress never goes backwards — UploadThing reports per-part
        // and a retried part would otherwise make the bar jump about.
        item.state === "uploading"
          ? { progress: clampProgress(Math.max(item.progress, action.progress)) }
          : null,
      );

    case "uploaded":
      return transition(state, action.captureId, "uploaded", () => ({
        progress: 1,
        retryable: false,
        ...(action.mediaState === undefined ? {} : { mediaState: action.mediaState }),
        ...(action.message === undefined ? {} : { message: action.message }),
      }));

    case "failed":
      return transition(state, action.captureId, "failed", () => ({
        message: action.message,
        retryable: action.retryable,
      }));

    case "cancelled":
      return transition(state, action.captureId, "cancelled", () => ({ progress: 0 }));

    case "forget":
      return { items: state.items.filter((item) => item.captureId !== action.captureId) };

    case "forgetSettled":
      return { items: state.items.filter((item) => !isSettled(item.state)) };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function findItem(state: UploadQueue, captureId: string): UploadItem | undefined {
  return state.items.find((item) => item.captureId === captureId);
}

/**
 * Apply a state change, refusing anything `captureStateMachine` calls illegal.
 *
 * A same-state move is legal by the machine's own rule (transitions are
 * idempotent because callbacks arrive twice) but is treated as a no-op here so a
 * duplicate `queued` cannot double-count `attempts`.
 */
function transition(
  state: UploadQueue,
  captureId: string,
  next: CaptureState,
  fields: (item: UploadItem) => Partial<UploadItem>,
): UploadQueue {
  return patch(state, captureId, (item) => {
    if (item.state === next) return null;
    if (!captureStateMachine.canTransition(item.state, next)) return null;
    return { ...fields(item), state: next };
  });
}

function patch(
  state: UploadQueue,
  captureId: string,
  update: (item: UploadItem) => Partial<UploadItem> | null,
): UploadQueue {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.captureId !== captureId) return item;
    const fields = update(item);
    if (fields === null) return item;
    changed = true;
    return { ...item, ...fields };
  });
  // Returning the identical object when nothing moved keeps React from
  // re-rendering the whole queue on every ignored progress tick.
  return changed ? { items } : state;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Object URLs outlive the component that made them unless somebody says so. */
export function releasePreview(item: UploadItem): void {
  if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
}
