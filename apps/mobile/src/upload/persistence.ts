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
  MEDIA_SOURCES,
  MEDIA_TYPES,
  type MediaSource,
  type MediaType,
} from "@partybooth/contracts/media";

import type { QueueItem } from "./types";

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
