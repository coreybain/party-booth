/**
 * The shape of one thing waiting to be sent.
 *
 * The vocabulary is **not** invented here. `CaptureState` and
 * `CAPTURE_UNDO_WINDOW_MS` come from `@partybooth/contracts/media`, which is the
 * same module `apps/web`'s capture page reads and the same one the backend's
 * media docs describe. The client-side names read a little oddly next to the
 * server's if you only ever see one of them, so the mapping is written down
 * once, here:
 *
 * | contracts    | what a guest sees                                  |
 * | ------------ | -------------------------------------------------- |
 * | `captured`   | the undo countdown — taken, nothing sent yet       |
 * | `queued`     | waiting for a grant, a network, or its turn        |
 * | `uploading`  | bytes in flight, with a progress bar               |
 * | `uploaded`   | the server has a row for it — terminal             |
 * | `failed`     | retryable; survives a restart and a foreground     |
 * | `cancelled`  | undone or abandoned — terminal                     |
 *
 * Everything in this file is data. No React, no Expo, no network: the reducer in
 * `./queue-reducer` and the engine helpers in `./queue-engine` are unit-tested
 * against these types in plain Node, which is the whole reason the durable queue
 * can be trusted without a device in the room.
 */

import {
  isTerminalCapture,
  TERMINAL_CAPTURE_STATES,
  type CaptureState,
  type DerivativeFileRole,
  type MediaSource,
  type MediaType,
} from "@partybooth/contracts/media";

/** Why an attempt stopped, in a sentence a guest can act on. */
export interface QueueFailure {
  /** Already written for a guest — backend messages arrive pre-worded. */
  readonly message: string;
  /**
   * Retrying on a timer cannot help: the party is paused, the file is over the
   * cap, the capture was withdrawn. The item still offers a manual retry (a
   * paused party un-pauses), but the engine stops spending battery on it.
   */
  readonly permanent: boolean;
}

/* -------------------------------------------------------------------------- */
/* Derivatives                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where one derivative has got to.
 *
 * Deliberately **not** `CaptureState`. A derivative has no undo window, cannot be
 * cancelled by a guest, and — this is the important one — its failure is not the
 * capture's failure. A photo whose preview never uploads is a photo that is in
 * the party; it just costs a fellow guest a smaller thumbnail. Reusing the
 * capture machine would have made the two indistinguishable to every selector
 * that asks "is this still on its way?", and the answer for a submission and for
 * its thumbnail is different.
 */
export type DerivativeState = "pending" | "uploading" | "uploaded" | "abandoned";

/**
 * A file the client made from the capture, waiting to go up beside it.
 *
 * These exist because of ADR 0008: Convex's isolate cannot host an image
 * pipeline and a server-side step would have to store the GPS-bearing original
 * before it could strip anything, so the client produces the derivatives with
 * the same re-encode that already drops the EXIF block. Each one is a **separate
 * grant for the same `captureId`** with a distinct `fileRole`, held to its own
 * much tighter cap, and refused outright unless it claims the re-encode.
 *
 * Two properties are load-bearing:
 *
 * - **A derivative is attempted only after its original is `uploaded`.** The
 *   backend refuses `derivativeWithoutOriginal` when no original grant exists
 *   for the capture, and while that refusal is retryable, racing it wastes a
 *   round trip on party wifi for no gain.
 * - **A derivative never settles the row.** `registerDerivative` writes one
 *   column and stops — no state change, no counter, no completion row. One
 *   capture stays one submission however many objects it arrives as.
 */
export interface QueueDerivative {
  readonly role: DerivativeFileRole;
  readonly state: DerivativeState;
  /** Local `file://` path to the re-encoded artefact. */
  readonly uri: string;
  readonly byteSize: number;
  readonly mimeType: string;
  /** Lower-case hex SHA-256 of exactly the bytes at `uri`. */
  readonly checksum: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** A video preview *clip* would carry one. A poster is a still and does not. */
  readonly durationSeconds?: number | undefined;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

/**
 * One capture in the durable queue.
 *
 * `uri` is the **submitted original** — the re-encoded, EXIF-free full-quality
 * frame, which PLAN.md defines as "original = final submitted capture".
 * `previewUri` is a small local thumbnail that never leaves the device; it
 * exists so the Photos tab can show something while the bytes are still in
 * flight and before any server-side derivative exists.
 *
 * `checksum` is a lower-case hex SHA-256 of exactly the bytes at `uri`, because
 * that is what `matchesGrant` compares against on the server. Recomputing it per
 * attempt would be wasted work *and* a correctness hazard — a retry must present
 * the same file it was granted.
 */
export interface QueueItem {
  /** Client-generated, stable across retries. Uploads are idempotent on it. */
  readonly captureId: string;
  readonly eventId: string;
  readonly state: CaptureState;
  readonly mediaType: MediaType;
  readonly mediaSource: MediaSource;

  readonly uri: string;
  readonly previewUri: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationSeconds?: number | undefined;

  readonly capturedAt: number;
  /**
   * What the client claims it **did** — that it re-encoded these bytes.
   * Recorded, never assumed. Required to be `true` for a derivative's grant.
   */
  readonly sourceMetadataStripped: boolean;
  /**
   * What the client claims is **true of** these bytes — that they carry no
   * location fix. The half the read path consults.
   *
   * Optional, and absent means "same as the re-encode claim": that is what a
   * photograph means, and it is what every row written before the split means.
   * The video path is the only thing that sets it on its own, because a clip
   * cannot be transcoded on a phone but the app can still promise there was
   * never a location to embed. See `MetadataClaim` in
   * `@partybooth/contracts/media`.
   */
  readonly sourceCarriesNoLocation?: boolean | undefined;

  /**
   * The artefacts to send alongside the original, once it has landed.
   *
   * Empty is a legitimate state and always has been: a capture with no
   * derivative is never stranded, it just shows a fellow guest less. It is also
   * what every row written before Sprint 4 deserialises to.
   */
  readonly derivatives: readonly QueueDerivative[];

  /**
   * Whether this capture sends itself when its window closes.
   *
   * A separate field rather than a sentinel in `sendAt`, because "waiting for a
   * countdown" and "waiting for a human" are different states of the same row
   * and the UI has to tell them apart: one shows a shrinking ring and an Undo
   * button, the other shows Send and Discard. Encoding the second as an
   * infinite deadline would also not survive `JSON.stringify`, which turns
   * `Infinity` into `null`.
   */
  readonly autoSend: boolean;
  /** When the undo window closes and this becomes `queued`. */
  readonly sendAt: number;
  /** The undo window this item was captured under, for the progress ring. */
  readonly undoDelayMs: number;

  readonly attempts: number;
  /** Earliest moment the engine may try again. Backoff lives here. */
  readonly nextAttemptAt: number;
  /** 0–1, transient. Persisted only so a restart does not flash back to zero. */
  readonly progress: number;
  readonly failure?: QueueFailure | undefined;
  /** Set once Convex acknowledges a media row for this capture. */
  readonly mediaId?: string | undefined;

  readonly updatedAt: number;
}

export interface QueueState {
  /** False until the on-disk queue has been read. Nothing may run before it. */
  readonly hydrated: boolean;
  readonly items: readonly QueueItem[];
}

export const EMPTY_QUEUE: QueueState = { hydrated: false, items: [] };

/**
 * States that no longer need the engine's attention.
 *
 * Re-exported rather than restated: the contract derives them from the capture
 * state machine's own transition table, so a state with nowhere left to go is
 * terminal by construction instead of by a second list somebody has to remember
 * to update. `apps/web` reads the same pair.
 */
export { isTerminalCapture, TERMINAL_CAPTURE_STATES };

/**
 * What the camera / picker hands the queue.
 *
 * Deliberately not a `QueueItem`: scheduling fields (`sendAt`, `nextAttemptAt`,
 * `attempts`) are the queue's business, and letting a caller supply them is how
 * a capture ends up with a send time in the past on a phone whose clock drifted.
 */
export interface CaptureDraft {
  readonly captureId: string;
  readonly eventId: string;
  readonly mediaType: MediaType;
  readonly mediaSource: MediaSource;
  readonly uri: string;
  readonly previewUri: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationSeconds?: number | undefined;
  readonly capturedAt: number;
  readonly sourceMetadataStripped: boolean;
  readonly sourceCarriesNoLocation?: boolean | undefined;
  /**
   * Already-encoded derivatives, in the state they leave the pipeline in.
   *
   * The pipeline produces them because it is the thing holding decoded pixels;
   * the queue schedules them because it is the thing that survives a restart.
   * `state`, `attempts` and `nextAttemptAt` are filled in by the queue, exactly
   * as the scheduling fields on the capture itself are.
   */
  readonly derivatives?: readonly DerivativeDraft[] | undefined;
}

/** One finished derivative, before the queue has decided anything about it. */
export interface DerivativeDraft {
  readonly role: DerivativeFileRole;
  readonly uri: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly checksum: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationSeconds?: number | undefined;
}
