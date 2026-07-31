/**
 * Turning the queue into bytes and back.
 *
 * Kept apart from the code that touches the filesystem (`./device-store`) for
 * the reason the rest of this app splits the same way: parsing something a
 * *previous build* wrote is where the bugs are, and it is testable in plain Node
 * only if no Expo module is imported alongside it.
 *
 * The contract with the future is one-directional and deliberately dull:
 *
 * - **Every field is validated, and one bad item does not lose the others.** A
 *   guest with nine good captures and one row written by a version that spelled
 *   a field differently keeps the nine. An all-or-nothing parse would throw away
 *   a whole evening's photos to be tidy.
 * - **`version` exists so a future format can migrate rather than guess.** An
 *   unrecognised version reads as an empty queue, which loses the *queue* but
 *   never the *files* — those are deleted only by an explicit sweep.
 * - **States are validated against the contract's machine.** A row claiming a
 *   state this build has never heard of is dropped, not coerced.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import {
  captureStateMachine,
  DERIVATIVE_FILE_ROLES,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  type DerivativeFileRole,
  type MediaSource,
  type MediaType,
} from "@partybooth/contracts/media";

import type { DerivativeState, QueueDerivative, QueueItem } from "./types";

/** Bumped only when a field changes meaning. Adding an optional field does not. */
export const QUEUE_FORMAT_VERSION = 1;

interface QueueFile {
  readonly version: number;
  readonly items: readonly QueueItem[];
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                              */
/* -------------------------------------------------------------------------- */

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isMediaType(value: unknown): value is MediaType {
  return typeof value === "string" && (MEDIA_TYPES as readonly string[]).includes(value);
}

function isMediaSource(value: unknown): value is MediaSource {
  return typeof value === "string" && (MEDIA_SOURCES as readonly string[]).includes(value);
}

function isDerivativeRole(value: unknown): value is DerivativeFileRole {
  return typeof value === "string" && (DERIVATIVE_FILE_ROLES as readonly string[]).includes(value);
}

const DERIVATIVE_STATES: readonly DerivativeState[] = [
  "pending",
  "uploading",
  "uploaded",
  "abandoned",
];

function isDerivativeState(value: unknown): value is DerivativeState {
  return typeof value === "string" && (DERIVATIVE_STATES as readonly string[]).includes(value);
}

/**
 * Read one persisted derivative, or `null` if it cannot be trusted.
 *
 * Same rule as a queue row: the required set is what an upload attempt needs to
 * be reconstructible without the device that made it. A derivative that fails
 * this drops out and its capture keeps every other one — losing a thumbnail is
 * not a reason to lose a photograph.
 *
 * An `uploading` state is read back as `pending`, for the same reason `hydrate`
 * rewrites the capture's: a request cannot outlive its process, so a row that
 * claims to be mid-flight on a cold start is a row that needs attempting again.
 */
function parseDerivative(raw: unknown): QueueDerivative | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const uri = str(source.uri);
  const mimeType = str(source.mimeType);
  const checksum = str(source.checksum);
  const byteSize = num(source.byteSize);

  if (
    !isDerivativeRole(source.role) ||
    uri === null ||
    mimeType === null ||
    checksum === null ||
    byteSize === null ||
    byteSize <= 0
  ) {
    return null;
  }

  const stored = isDerivativeState(source.state) ? source.state : "pending";
  const width = optionalNum(source.width);
  const height = optionalNum(source.height);
  const durationSeconds = optionalNum(source.durationSeconds);

  return {
    role: source.role,
    state: stored === "uploading" ? "pending" : stored,
    uri,
    byteSize,
    mimeType,
    checksum,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    attempts: Math.max(0, Math.trunc(num(source.attempts) ?? 0)),
    nextAttemptAt: num(source.nextAttemptAt) ?? 0,
  };
}

/**
 * All of a row's derivatives.
 *
 * Absent reads as none, which is exactly right for a row written before Sprint 4
 * — that capture genuinely has no derivative and never will, and the read path
 * copes (`mayServeOriginal`'s "serve nothing" branch survives for this case).
 * Duplicates are dropped rather than merged: one capture has one object per
 * role, and a second is the shape that would produce `duplicateDerivative` on
 * the server.
 */
function readDerivatives(value: unknown): QueueDerivative[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<DerivativeFileRole>();
  const derivatives: QueueDerivative[] = [];
  for (const entry of value) {
    const derivative = parseDerivative(entry);
    if (derivative === null || seen.has(derivative.role)) continue;
    seen.add(derivative.role);
    derivatives.push(derivative);
  }
  return derivatives;
}

function readFailure(value: unknown): QueueItem["failure"] {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const message = str(source.message);
  if (message === null) return undefined;
  return { message, permanent: bool(source.permanent, false) };
}

/**
 * Read one persisted row, or `null` if it cannot be trusted.
 *
 * The required set is exactly what an upload attempt needs to be reconstructible
 * without the device that made it: the identity, the party, the file, and the
 * hash the server will check the file against. Everything else has a sane
 * fallback, because an item that has lost its progress bar is still an item and
 * an item that has lost its checksum is not.
 */
export function parseQueueItem(raw: unknown): QueueItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const captureId = str(source.captureId);
  const ownerUserId = str(source.ownerUserId);
  const eventId = str(source.eventId);
  const uri = str(source.uri);
  const mimeType = str(source.mimeType);
  const checksum = str(source.checksum);
  const byteSize = num(source.byteSize);
  const capturedAt = num(source.capturedAt);
  const state = source.state;

  if (
    captureId === null ||
    eventId === null ||
    uri === null ||
    mimeType === null ||
    checksum === null ||
    byteSize === null ||
    byteSize <= 0 ||
    capturedAt === null ||
    !captureStateMachine.isState(state) ||
    !isMediaType(source.mediaType) ||
    !isMediaSource(source.mediaSource)
  ) {
    return null;
  }

  const undoDelayMs = num(source.undoDelayMs) ?? 0;
  const sendAt = num(source.sendAt) ?? capturedAt + undoDelayMs;
  const failure = readFailure(source.failure);
  const mediaId = str(source.mediaId);
  const width = optionalNum(source.width);
  const height = optionalNum(source.height);
  const durationSeconds = optionalNum(source.durationSeconds);

  return {
    // Absent means a pre-ownership row. Keep it so its local files are not
    // silently lost, but never guess who owns it; the provider quarantines it.
    ...(ownerUserId === null ? {} : { ownerUserId }),
    captureId,
    eventId,
    state,
    mediaType: source.mediaType,
    mediaSource: source.mediaSource,
    uri,
    // A lost thumbnail is cosmetic; the original is what gets sent.
    previewUri: str(source.previewUri) ?? uri,
    byteSize,
    mimeType,
    checksum,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    capturedAt,
    sourceMetadataStripped: bool(source.sourceMetadataStripped, false),
    // Left absent rather than defaulted when a stored row does not have it: an
    // absent value means "same as the re-encode claim", which is exactly what
    // every row written before the split meant. Defaulting it to `false` here
    // would silently withdraw a restored photo from the gallery.
    ...(typeof source.sourceCarriesNoLocation === "boolean"
      ? { sourceCarriesNoLocation: source.sourceCarriesNoLocation }
      : {}),
    derivatives: readDerivatives(source.derivatives),
    // A row from before this field existed was auto-send by definition — it is
    // the only thing the app could produce at the time.
    autoSend: bool(source.autoSend, true),
    sendAt,
    undoDelayMs,
    attempts: Math.max(0, Math.trunc(num(source.attempts) ?? 0)),
    nextAttemptAt: num(source.nextAttemptAt) ?? sendAt,
    progress: Math.min(1, Math.max(0, num(source.progress) ?? 0)),
    ...(failure === undefined ? {} : { failure }),
    ...(mediaId === null ? {} : { mediaId }),
    updatedAt: num(source.updatedAt) ?? capturedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Whole file                                                                 */
/* -------------------------------------------------------------------------- */

export function serialiseQueue(items: readonly QueueItem[]): string {
  const file: QueueFile = { version: QUEUE_FORMAT_VERSION, items };
  return JSON.stringify(file);
}

/**
 * Read the persisted queue. Never throws — an unreadable file is an empty queue.
 *
 * Absent, malformed, wrong-version and "an array where an object was expected"
 * all collapse to the same answer on purpose. There is nothing a guest can do
 * about any of them, and the recovery is identical: start clean and let the
 * sweep remove the orphaned files.
 */
export function parseQueue(raw: string | null | undefined): QueueItem[] {
  if (raw === null || raw === undefined || raw.length === 0) return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof decoded !== "object" || decoded === null) return [];
  const file = decoded as Record<string, unknown>;
  if (file.version !== QUEUE_FORMAT_VERSION) return [];
  if (!Array.isArray(file.items)) return [];

  const items: QueueItem[] = [];
  for (const entry of file.items) {
    const item = parseQueueItem(entry);
    if (item !== null) items.push(item);
  }
  return items;
}
