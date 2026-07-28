import { z } from "zod";

import type { ModerationMode } from "./events";
import type { Role } from "./roles";
import { createStateMachine, type TransitionTable } from "./state-machine";

/* -------------------------------------------------------------------------- */
/* Media type                                                                 */
/* -------------------------------------------------------------------------- */

export const MEDIA_TYPES = ["photo", "video"] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

export const mediaTypeSchema = z.enum(MEDIA_TYPES);

/* -------------------------------------------------------------------------- */
/* Where a capture came from                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How the file reached the app.
 *
 * - `capture` — the camera, in our own UI. The only path that can promise the
 *   frame was re-encoded before it left the device (see `stripsMetadata` in
 *   `upload.ts`).
 * - `library` — picked from the phone's photo roll. Gated per event by
 *   `events.allowLibraryImport`, because "photos from tonight" and "any photo
 *   you have ever taken" are different products and some hosts only want one.
 *
 * The database and the wire carry the boolean `fromLibrary` — it predates this
 * enum and the `media` table is built on it — so the two are kept in step by
 * {@link mediaSourceOf} and {@link fromLibraryOf} rather than stored twice.
 */
export const MEDIA_SOURCES = ["capture", "library"] as const;

export type MediaSource = (typeof MEDIA_SOURCES)[number];

export const mediaSourceSchema = z.enum(MEDIA_SOURCES);

export function mediaSourceOf(fromLibrary: boolean): MediaSource {
  return fromLibrary ? "library" : "capture";
}

export function fromLibraryOf(source: MediaSource): boolean {
  return source === "library";
}

export function isLibraryImport(source: MediaSource): boolean {
  return source === "library";
}

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

/* -------------------------------------------------------------------------- */
/* Who may see which rows                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The states a role may see in an event listing, ignoring ownership.
 *
 * This is the read-path half of the privacy invariant in PLAN.md: *pending and
 * declined media are visible only to the submitter and the hosts.* Written as
 * data rather than as an `if` in each query, because there are three listing
 * surfaces (my media, the moderation queue, the gallery) and a rule spelled out
 * three times is a rule that will eventually be spelled out three ways.
 *
 * `deleted` is in nobody's list, ever — a withdrawal is permanent, and the row
 * survives only for the audit trail and the purge worker.
 *
 * `globalAdmin` gets the empty set on purpose: admins manage accounts, events
 * and audit, and never look at guests' photos (`CAPABILITIES` in
 * `permissions.ts` gives them no `media.*` action at all).
 */
export const VISIBLE_MEDIA_STATES: Record<Role, readonly MediaState[]> = {
  globalAdmin: [],
  owner: ["processing", "pending", "approved", "declined"],
  cohost: ["processing", "pending", "approved", "declined"],
  guest: ["approved"],
};

export function visibleMediaStatesFor(role: Role): readonly MediaState[] {
  return VISIBLE_MEDIA_STATES[role];
}

export interface MediaVisibilitySubject {
  state: MediaState;
  /** Whether the acting user submitted this item. */
  isOwn: boolean;
}

/**
 * May this role see this row at all?
 *
 * Ownership is additive: a guest sees every state of **their own** capture (that
 * is the "my media" list, where a `pending` item has to show as pending), and
 * only `approved` from anybody else. Hosts see everything either way. Nothing
 * gets anyone to `deleted`.
 */
export function canSeeMedia(role: Role, subject: MediaVisibilitySubject): boolean {
  if (subject.state === "deleted") return false;
  if (subject.isOwn) return role !== "globalAdmin";
  return visibleMediaStatesFor(role).includes(subject.state);
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

/**
 * States from which nothing further happens on its own — the queue is done with
 * the item and may stop watching it.
 *
 * Derived from the transition table rather than restated: a state with nowhere
 * left to go *is* a terminal state, so adding one to `CAPTURE_TRANSITIONS` with
 * an empty target list puts it here automatically instead of leaving a second
 * list to forget.
 */
export const TERMINAL_CAPTURE_STATES: readonly CaptureState[] = CAPTURE_STATES.filter(
  (state) => CAPTURE_TRANSITIONS[state].length === 0,
);

export function isTerminalCapture(state: CaptureState): boolean {
  return TERMINAL_CAPTURE_STATES.includes(state);
}

/**
 * Is this capture still going to change without the guest doing anything?
 *
 * `failed` is deliberately excluded even though `apps/mobile` retries it on a
 * timer: what this answers is "should the UI show a spinner", and a failure that
 * is waiting out a backoff has something to say to the guest ("couldn't send —
 * trying again") rather than nothing.
 */
export function isCaptureInFlight(state: CaptureState): boolean {
  return state === "queued" || state === "uploading";
}

/** How long the guest has to undo an auto-send after a capture. */
export const CAPTURE_UNDO_WINDOW_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* File roles — one capture, several stored objects                           */
/* -------------------------------------------------------------------------- */

/**
 * Which artefact of a capture a stored object *is*.
 *
 * A capture is one `media` row and one `captureId`, but up to three objects in
 * storage. They are distinguished by role rather than by separate captures,
 * because everything that makes the upload spine safe — the single-use grant,
 * `(eventId, captureId)` idempotency, withdrawal expiring every unspent grant —
 * is keyed on the capture and must stay keyed on the capture.
 *
 * - `original` — the frame the guest submitted. Full resolution. Served only to
 *   its submitter and the hosts unless the client confirmed it re-encoded away
 *   the EXIF/GPS block (see `mayServeOriginal` in the backend).
 * - `preview` — the artefact a **third party** is served: a downscaled image for
 *   a photo, a short muted clip for a video. This is what a gallery and a
 *   slideshow render.
 * - `poster` — a video's still frame, for the thumbnail and the first painted
 *   frame before playback starts. Photos have no poster.
 *
 * ADR 0008 is where the "who produces these" question is answered, and the
 * answer is the client: Convex's isolate cannot host an image pipeline, and a
 * server-side step would have to write the GPS-bearing original to storage
 * before it could strip anything (ADR 0004 §7).
 */
export const MEDIA_FILE_ROLES = ["original", "preview", "poster"] as const;

export type MediaFileRole = (typeof MEDIA_FILE_ROLES)[number];

export const mediaFileRoleSchema = z.enum(MEDIA_FILE_ROLES);

/** Every role that is not the submitted frame itself. */
export const DERIVATIVE_FILE_ROLES = ["preview", "poster"] as const;

export type DerivativeFileRole = (typeof DERIVATIVE_FILE_ROLES)[number];

export function isDerivativeRole(role: MediaFileRole): role is DerivativeFileRole {
  return role !== "original";
}

/**
 * The derivatives a client is expected to send alongside each type of original.
 *
 * "Expected", not "required": a media row settles out of `processing` when its
 * **original** lands, and derivatives attach whenever they arrive, in any order.
 * That is deliberate — a phone that dies between the original and the preview
 * must not leave a capture stranded in `processing` for ever. What a missing
 * preview costs is visibility to fellow guests, not the item itself.
 */
export const DERIVATIVE_ROLES_BY_TYPE = {
  photo: ["preview"],
  video: ["poster", "preview"],
} as const satisfies Record<MediaType, readonly DerivativeFileRole[]>;

export function derivativeRolesFor(mediaType: MediaType): readonly DerivativeFileRole[] {
  return DERIVATIVE_ROLES_BY_TYPE[mediaType];
}

/** Whether this role is meaningful for this media type. Photos have no poster. */
export function isFileRoleAllowed(mediaType: MediaType, role: MediaFileRole): boolean {
  if (role === "original") return true;
  return derivativeRolesFor(mediaType).includes(role);
}

/* -------------------------------------------------------------------------- */
/* What a client claims about the bytes it is sending                         */
/* -------------------------------------------------------------------------- */

/**
 * The two separate promises a client makes about a file's metadata.
 *
 * These were one boolean (`sourceMetadataStripped`) until Sprint 4, and for a
 * photograph they really are the same fact: the re-encode *is* the mechanism by
 * which no location survives. Video broke that identity, and the single flag
 * then had to mean whichever of the two the reader happened to need:
 *
 * - **`reEncoded`** — these bytes went through a decode/encode round trip, so
 *   whatever container the camera wrote no longer exists. This is the claim a
 *   **derivative** grant requires (`derivativeMetadataNotStripped`), because a
 *   derivative is what third parties are handed and "I re-encoded it" is a
 *   statement about a process we can reason about.
 * - **`carriesNoLocation`** — there is no location fix in this file. This is the
 *   claim the **read path** consults (`mayServeOriginal` in the backend), because
 *   the privacy invariant in PLAN.md is about location, not about encoders.
 *
 * A 60-second clip cannot be re-encoded on a phone in the time a guest will
 * wait, and nothing in either client's toolchain transcodes video at all. So
 * `apps/mobile` sends a clip with `reEncoded: false` and `carriesNoLocation:
 * true` — the second justified structurally rather than mechanically: the app
 * ships no location permission on either platform (`blockedPermissions` on
 * Android, no `NSLocation*` on iOS), so there is no fix for the recorder to
 * embed, and video library import is deliberately not built. `apps/web` cannot
 * make either claim for a clip a guest picked from their camera roll, and says
 * so: both `false`.
 *
 * Keeping them apart is what lets each side ask its own question honestly
 * instead of reading a flag whose name answers the other one.
 */
export interface MetadataClaim {
  /** The bytes were decoded and re-encoded, so no source container survived. */
  readonly reEncoded: boolean;
  /** No location metadata is present, by whatever route. */
  readonly carriesNoLocation: boolean;
}

/**
 * How the claim travels: two optional booleans, both absent on every pre-Sprint-4
 * row.
 *
 * `sourceMetadataStripped` keeps its name and its meaning — *the strip happened,
 * by re-encoding* — so no stored row changes meaning and no migration is needed.
 * `sourceCarriesNoLocation` is the new half, and is only ever set by a client
 * that means something different by it.
 */
export interface MetadataClaimFields {
  readonly sourceMetadataStripped?: boolean | undefined;
  readonly sourceCarriesNoLocation?: boolean | undefined;
}

/**
 * Read a stored or wire-borne claim, defaulting the way history requires.
 *
 * The fallback is the load-bearing part: a row written before the split carries
 * only `sourceMetadataStripped`, and a client that re-encoded a photograph was
 * thereby also promising there was no location left in it. So an absent
 * `sourceCarriesNoLocation` inherits the re-encode claim, and every existing row
 * keeps exactly the visibility it had. Absent-and-absent is `false` on both,
 * which is the conservative reading and the one Sprint 3 already applied.
 */
export function metadataClaimOf(fields: MetadataClaimFields): MetadataClaim {
  const reEncoded = fields.sourceMetadataStripped === true;
  return {
    reEncoded,
    carriesNoLocation: fields.sourceCarriesNoLocation ?? reEncoded,
  };
}

/**
 * May the **original** be handed to somebody who is not its submitter or a host?
 *
 * Location, not encoding — see {@link MetadataClaim}. The backend's
 * `mayServeOriginal` is this rule plus the viewer check.
 */
export function originalIsServableToThirdParties(fields: MetadataClaimFields): boolean {
  return metadataClaimOf(fields).carriesNoLocation;
}

/** Write a claim back out to the wire. Omits `false`-by-default absences. */
export function metadataClaimFields(claim: MetadataClaim): MetadataClaimFields {
  return {
    sourceMetadataStripped: claim.reEncoded,
    sourceCarriesNoLocation: claim.carriesNoLocation,
  };
}

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

/**
 * Ceilings for the derivatives, which are much tighter than the originals'.
 *
 * The tightness is doing real work rather than saving pennies. A derivative is
 * the one artefact served to people who are not the submitter, so "this is a
 * re-encode" has to be more than a claim — and a 12-megapixel camera JPEG with
 * its EXIF block intact does not fit in two megabytes. It is not proof (a small
 * image can still carry GPS) but it is the cheapest available corroboration,
 * and it is why the preview cap is not simply "the photo cap".
 *
 * A video's `preview` is a short muted clip rather than an image, so it gets its
 * own, larger ceiling; its `poster` is a still and gets the image one.
 */
export const DERIVATIVE_IMAGE_MIME_TYPES = ["image/jpeg", "image/webp", "image/png"] as const;

export const DERIVATIVE_LIMITS = {
  /** Applies to a photo's preview and to any poster. */
  image: { maxBytes: 2 * MIB },
  /** A video's preview clip: downscaled, muted, ≤ the original's duration. */
  videoPreview: { maxBytes: 25 * MIB },
} as const;

export function maxBytesFor(mediaType: MediaType): number {
  return MEDIA_LIMITS[mediaType].maxBytes;
}

export function allowedMimeTypes(mediaType: MediaType): readonly string[] {
  return MEDIA_LIMITS[mediaType].mimeTypes;
}

/** The byte ceiling for one exact `(mediaType, role)` pair. */
export function maxBytesForRole(mediaType: MediaType, role: MediaFileRole): number {
  if (role === "original") return maxBytesFor(mediaType);
  if (role === "preview" && mediaType === "video") return DERIVATIVE_LIMITS.videoPreview.maxBytes;
  return DERIVATIVE_LIMITS.image.maxBytes;
}

/** The formats accepted for one exact `(mediaType, role)` pair. */
export function allowedMimeTypesForRole(
  mediaType: MediaType,
  role: MediaFileRole,
): readonly string[] {
  if (role === "original") return allowedMimeTypes(mediaType);
  if (role === "preview" && mediaType === "video") return MEDIA_LIMITS.video.mimeTypes;
  return DERIVATIVE_IMAGE_MIME_TYPES;
}

export interface MediaFileCandidate {
  mediaType: MediaType;
  byteSize: number;
  mimeType?: string | undefined;
  /** Required for videos; ignored for photos. */
  durationSeconds?: number | undefined;
  /**
   * Which artefact of the capture this is. Absent means `original`, which is
   * what every pre-Sprint-4 caller meant and still means.
   */
  fileRole?: MediaFileRole | undefined;
}

export type MediaRejectionReason =
  | "emptyFile"
  | "tooLarge"
  | "unsupportedMimeType"
  | "missingDuration"
  | "tooLong"
  /** A poster for a photo, or any other role its media type does not have. */
  | "unsupportedFileRole";

export type MediaValidationResult =
  { ok: true } | { ok: false; reason: MediaRejectionReason; message: string; limit?: number };

/**
 * Validate a candidate file **before** asking Convex for an upload grant, and
 * again inside the grant mutation. Same function both sides: a client that
 * skips the check gets the identical rejection from the server.
 *
 * Every ceiling it consults is `(mediaType, fileRole)`-shaped, so a preview is
 * held to the preview cap rather than to the original's — which is the whole
 * reason the caps are separate. `durationSeconds` is required for a video's
 * original and for a video's preview clip, and meaningless for a poster.
 */
export function validateMediaFile(candidate: MediaFileCandidate): MediaValidationResult {
  const { mediaType, byteSize, mimeType, durationSeconds } = candidate;
  const fileRole: MediaFileRole = candidate.fileRole ?? "original";

  if (!isFileRoleAllowed(mediaType, fileRole)) {
    return {
      ok: false,
      reason: "unsupportedFileRole",
      message: `A ${mediaType} has no ${fileRole}.`,
    };
  }

  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return { ok: false, reason: "emptyFile", message: "File is empty." };
  }

  const maxBytes = maxBytesForRole(mediaType, fileRole);
  if (byteSize > maxBytes) {
    return {
      ok: false,
      reason: "tooLarge",
      message:
        fileRole === "original"
          ? `${mediaType === "photo" ? "Photos" : "Videos"} must be ${formatMib(maxBytes)} or smaller.`
          : `A ${fileRole} must be ${formatMib(maxBytes)} or smaller.`,
      limit: maxBytes,
    };
  }

  if (mimeType !== undefined && !allowedMimeTypesForRole(mediaType, fileRole).includes(mimeType)) {
    return {
      ok: false,
      reason: "unsupportedMimeType",
      message: `${mimeType} is not a supported ${mediaType} ${fileRole} format.`,
    };
  }

  // A poster is a still frame: it has no duration, and demanding one would
  // refuse every legitimate video thumbnail.
  const needsDuration = mediaType === "video" && fileRole !== "poster";
  if (needsDuration) {
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
/* Moderation actions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a host presses, as opposed to what gets recorded.
 *
 * `approve` and `decline` map one-to-one onto {@link MODERATION_DECISIONS}.
 * `revoke` is the third button and it is **not** a fourth decision: it lands the
 * item in `declined` exactly as a decline does, and the `moderationDecisions`
 * row it writes says `declined`. What makes it its own action is the *guard* —
 * it refuses anything that is not currently `approved`, so "un-approve this"
 * cannot silently become "decline this thing that was never approved" when two
 * hosts moderate the same grid at once.
 *
 * There is no `approved → pending`. The media state machine does not have that
 * edge and it should not: a host taking a photo off the wall has made a
 * decision, and putting it back in the queue would mean the pending badge — the
 * thing that tells a host whether to keep moderating — counts items nobody is
 * waiting on.
 */
export const MODERATION_ACTIONS = ["approve", "decline", "revoke"] as const;

export type ModerationActionName = (typeof MODERATION_ACTIONS)[number];

export const moderationActionSchema = z.enum(MODERATION_ACTIONS);

/**
 * Why a moderation action could not be applied.
 *
 * - `stillProcessing` — the bytes have not landed. There is nothing to look at.
 * - `withdrawn` — the submitter took it back. Withdrawal is permanent.
 * - `notApproved` — `revoke` against something that is not approved.
 */
export const MODERATION_REFUSALS = ["stillProcessing", "withdrawn", "notApproved"] as const;

export type ModerationRefusal = (typeof MODERATION_REFUSALS)[number];

export const MODERATION_REFUSAL_MESSAGES: Record<ModerationRefusal, string> = {
  stillProcessing: "That one is still uploading.",
  withdrawn: "The guest withdrew that one.",
  notApproved: "That one is not approved, so there is nothing to take back.",
};

export type ModerationTransition =
  | {
      ok: true;
      next: MediaState;
      decision: ModerationDecision;
      /** `false` when the item was already in the target state — a no-op. */
      changed: boolean;
    }
  | { ok: false; reason: ModerationRefusal; message: string };

/**
 * Is this action legal on an item in this state, and where does it land?
 *
 * Pure, so the moderation grid can grey out a button using the same rule the
 * mutation enforces, and so the bulk path can partition a selection into "these
 * moved" and "these could not" without a round trip per item.
 *
 * Idempotence is a first-class answer rather than an error: approving something
 * already approved returns `changed: false`. Two hosts double-tapping the same
 * card at 1am is the common case, and it must not produce a second
 * `moderationDecisions` row or a second audit line.
 */
export function moderationTransition(
  action: ModerationActionName,
  from: MediaState,
): ModerationTransition {
  if (from === "deleted") return moderationRefused("withdrawn");
  if (from === "processing") return moderationRefused("stillProcessing");

  if (action === "revoke" && from !== "approved") return moderationRefused("notApproved");

  const next: MediaState = action === "approve" ? "approved" : "declined";
  return {
    ok: true,
    next,
    decision: next === "approved" ? "approved" : "declined",
    changed: from !== next,
  };
}

function moderationRefused(reason: ModerationRefusal): ModerationTransition {
  return { ok: false, reason, message: MODERATION_REFUSAL_MESSAGES[reason] };
}

/* -------------------------------------------------------------------------- */
/* Chronological cursors (gallery and slideshow)                              */
/* -------------------------------------------------------------------------- */

/**
 * A position in a chronologically-ordered media list.
 *
 * `createdAt` alone is not a position: two captures uploaded in the same
 * millisecond at a party where fifty phones are firing is not a hypothetical,
 * and a cursor that cannot break that tie either skips an item or repeats one.
 * Pairing the timestamp with the row id makes the ordering total.
 */
export interface MediaCursor {
  createdAt: number;
  /** Convex document id. Opaque outside `packages/backend`. */
  id: string;
}

const CURSOR_PATTERN = /^(\d{1,15}):([A-Za-z0-9_-]{1,64})$/;

export function encodeMediaCursor(cursor: MediaCursor): string {
  return `${Math.trunc(cursor.createdAt)}:${cursor.id}`;
}

/** `undefined` for anything that is not a cursor — a bad one means "start". */
export function decodeMediaCursor(value: string | null | undefined): MediaCursor | undefined {
  if (typeof value !== "string") return undefined;
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return undefined;
  const [, createdAt, id] = match;
  if (createdAt === undefined || id === undefined) return undefined;
  return { createdAt: Number(createdAt), id };
}

/** Oldest first, ties broken by id. The slideshow's order. */
export function compareChronological(a: MediaCursor, b: MediaCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Strictly after the cursor, in {@link compareChronological} order. */
export function isAfterCursor(item: MediaCursor, cursor: MediaCursor | undefined): boolean {
  if (cursor === undefined) return true;
  return compareChronological(item, cursor) > 0;
}

/* -------------------------------------------------------------------------- */
/* Report lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What has happened to a content report.
 *
 * Reports are not decisions. A host who declines the reported item resolves the
 * report as `actioned`; one who looks and disagrees resolves it as `dismissed`.
 * Both are answers, and App Review wants to see that an answer is possible.
 */
export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const reportStatusSchema = z.enum(REPORT_STATUSES);

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
