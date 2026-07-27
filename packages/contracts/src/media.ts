import { z } from "zod";

import type { ModerationMode } from "./events";
import { createStateMachine, type TransitionTable } from "./state-machine";

/* -------------------------------------------------------------------------- */
/* Media type                                                                 */
/* -------------------------------------------------------------------------- */

export const MEDIA_TYPES = ["photo", "video"] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

export const mediaTypeSchema = z.enum(MEDIA_TYPES);

/* -------------------------------------------------------------------------- */
/* Server-side media lifecycle                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle of a `media` row (server side).
 *
 * - `processing` — the upload completed and derivatives are being made. This is
 *   the state a row is created in by the UploadThing completion callback.
 * - `pending` — awaiting a moderation decision (`manual` mode, and `ai` until
 *   P1 lands).
 * - `approved` — visible in the gallery and the slideshow.
 * - `declined` — hidden from everyone except the submitter and the hosts.
 * - `deleted` — withdrawn by the guest or removed by the owner. Terminal, and
 *   the state every read path must treat as "does not exist".
 */
export const MEDIA_STATES = ["processing", "pending", "approved", "declined", "deleted"] as const;

export type MediaState = (typeof MEDIA_STATES)[number];

export const mediaStateSchema = z.enum(MEDIA_STATES);

const MEDIA_TRANSITIONS: TransitionTable<MediaState> = {
  // `automatic` mode jumps straight to approved once derivatives are ready.
  processing: ["pending", "approved", "deleted"],
  pending: ["approved", "declined", "deleted"],
  // Hosts change their mind constantly during a party; both directions stay open.
  approved: ["declined", "deleted"],
  declined: ["approved", "deleted"],
  deleted: [],
};

export const mediaStateMachine = createStateMachine("Media", MEDIA_STATES, MEDIA_TRANSITIONS);

/** States a moderator may act on. */
export const MODERATABLE_MEDIA_STATES = [
  "pending",
  "approved",
  "declined",
] as const satisfies readonly MediaState[];

/** States that count toward the organiser's "pending" badge. */
export const PENDING_MEDIA_STATES = ["pending"] as const satisfies readonly MediaState[];

export function isModeratable(state: MediaState): boolean {
  return (MODERATABLE_MEDIA_STATES as readonly MediaState[]).includes(state);
}

export function isMediaVisibleToGuests(state: MediaState): boolean {
  return state === "approved";
}

/**
 * Where a freshly-uploaded item lands once processing finishes, given the
 * event's moderation mode.
 *
 * `ai` behaves exactly like `manual` at launch: the classifier is post-launch
 * (P1) and the agreed policy is conservative auto-approve, **never**
 * auto-decline — so until it exists, everything queues for a human.
 */
export function mediaStateAfterProcessing(mode: ModerationMode): MediaState {
  return mode === "automatic" ? "approved" : "pending";
}

/* -------------------------------------------------------------------------- */
/* Client-side capture lifecycle                                              */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle of a capture in the **client's** durable queue (app and web). This
 * never reaches the server as a state — the server sees a media row — but both
 * clients need the same vocabulary, and the 15-second undo window is a product
 * promise worth pinning down in one place.
 *
 * - `captured` — just taken, inside the undo window; nothing has been sent.
 * - `queued` — undo expired (or the user hit send); waiting for a grant/network.
 * - `uploading` — bytes in flight.
 * - `uploaded` — the completion callback was acknowledged. Terminal.
 * - `failed` — retryable failure; stays on device so a foreground resume can
 *   pick it up.
 * - `cancelled` — undone inside the window, or abandoned by the user. Terminal.
 */
export const CAPTURE_STATES = [
  "captured",
  "queued",
  "uploading",
  "uploaded",
  "failed",
  "cancelled",
] as const;

export type CaptureState = (typeof CAPTURE_STATES)[number];

export const captureStateSchema = z.enum(CAPTURE_STATES);

const CAPTURE_TRANSITIONS: TransitionTable<CaptureState> = {
  captured: ["queued", "cancelled"],
  queued: ["uploading", "cancelled"],
  uploading: ["uploaded", "failed", "cancelled"],
  uploaded: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export const captureStateMachine = createStateMachine(
  "Capture",
  CAPTURE_STATES,
  CAPTURE_TRANSITIONS,
);

/** How long the guest has to undo an auto-send after a capture. */
export const CAPTURE_UNDO_WINDOW_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* Per-file limits                                                            */
/* -------------------------------------------------------------------------- */

const MIB = 1024 * 1024;

/**
 * Hard per-file limits (PLAN.md: photos ≤ 20 MB, videos ≤ 60 s / 250 MB).
 * Byte figures are binary megabytes, which is what every client-side
 * `file.size` comparison will informally assume anyway.
 */
export const MEDIA_LIMITS = {
  photo: {
    maxBytes: 20 * MIB,
    mimeTypes: ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"],
  },
  video: {
    maxBytes: 250 * MIB,
    maxDurationSeconds: 60,
    mimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  },
} as const;

export const PHOTO_MAX_BYTES = MEDIA_LIMITS.photo.maxBytes;
export const VIDEO_MAX_BYTES = MEDIA_LIMITS.video.maxBytes;
export const VIDEO_MAX_DURATION_SECONDS = MEDIA_LIMITS.video.maxDurationSeconds;

export function maxBytesFor(mediaType: MediaType): number {
  return MEDIA_LIMITS[mediaType].maxBytes;
}

export function allowedMimeTypes(mediaType: MediaType): readonly string[] {
  return MEDIA_LIMITS[mediaType].mimeTypes;
}

export interface MediaFileCandidate {
  mediaType: MediaType;
  byteSize: number;
  mimeType?: string | undefined;
  /** Required for videos; ignored for photos. */
  durationSeconds?: number | undefined;
}

export type MediaRejectionReason =
  "emptyFile" | "tooLarge" | "unsupportedMimeType" | "missingDuration" | "tooLong";

export type MediaValidationResult =
  { ok: true } | { ok: false; reason: MediaRejectionReason; message: string; limit?: number };

/**
 * Validate a candidate file **before** asking Convex for an upload grant, and
 * again inside the grant mutation. Same function both sides: a client that
 * skips the check gets the identical rejection from the server.
 */
export function validateMediaFile(candidate: MediaFileCandidate): MediaValidationResult {
  const { mediaType, byteSize, mimeType, durationSeconds } = candidate;

  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return { ok: false, reason: "emptyFile", message: "File is empty." };
  }

  const maxBytes = maxBytesFor(mediaType);
  if (byteSize > maxBytes) {
    return {
      ok: false,
      reason: "tooLarge",
      message: `${mediaType === "photo" ? "Photos" : "Videos"} must be ${formatMib(maxBytes)} or smaller.`,
      limit: maxBytes,
    };
  }

  if (mimeType !== undefined && !allowedMimeTypes(mediaType).includes(mimeType)) {
    return {
      ok: false,
      reason: "unsupportedMimeType",
      message: `${mimeType} is not a supported ${mediaType} format.`,
    };
  }

  if (mediaType === "video") {
    if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
      return {
        ok: false,
        reason: "missingDuration",
        message: "Video duration is required.",
      };
    }
    if (durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      return {
        ok: false,
        reason: "tooLong",
        message: `Videos must be ${VIDEO_MAX_DURATION_SECONDS} seconds or shorter.`,
        limit: VIDEO_MAX_DURATION_SECONDS,
      };
    }
  }

  return { ok: true };
}

function formatMib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Moderation decisions                                                       */
/* -------------------------------------------------------------------------- */

export const MODERATION_DECISIONS = ["approved", "declined"] as const;

export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export const moderationDecisionSchema = z.enum(MODERATION_DECISIONS);

/** Who made a moderation decision — `ai` is reserved for P1. */
export const MODERATION_ACTORS = ["host", "automatic", "ai"] as const;

export type ModerationActor = (typeof MODERATION_ACTORS)[number];

export const moderationActorSchema = z.enum(MODERATION_ACTORS);

export function mediaStateForDecision(decision: ModerationDecision): MediaState {
  return decision;
}

/* -------------------------------------------------------------------------- */
/* Content reports (App Review requirement)                                   */
/* -------------------------------------------------------------------------- */

export const REPORT_REASONS = [
  "nudityOrSexual",
  "violenceOrGore",
  "hateOrHarassment",
  "illegalOrDangerous",
  "notMyPhoto",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const reportReasonSchema = z.enum(REPORT_REASONS);
