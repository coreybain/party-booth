/**
 * Capture settings — the two knobs PLAN.md puts in front of a guest.
 *
 * - **Auto-send, per media type.** Off means a capture sits in the undo state
 *   until it is sent by hand. Per type because "everything I photograph goes
 *   straight up, but let me look at a video before it does" is a real
 *   preference, and because the two have very different costs on party wifi.
 * - **The undo delay, 0–60 s.** Defaults to the contract's 15 seconds.
 *
 * Video is present in the type even though hold-to-record is Sprint 4. The
 * setting costs one boolean, and a settings screen that grows a new row on the
 * day the camera does is a settings screen whose persistence format changes on
 * the day the camera does.
 *
 * Parsing is hand-rolled rather than zod'd, matching `./profile.ts`: this reads
 * a file a previous build wrote, so *every* field has to survive being absent,
 * being the wrong type, or being a number from a future version. The rule is the
 * same everywhere — unusable input falls back to the default, and nothing here
 * throws.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import { MEDIA_TYPES, type MediaType } from "@partybooth/contracts/media";

import { DEFAULT_UNDO_DELAY_MS, normaliseDelayMs } from "./countdown";

export interface CaptureSettings {
  /** Whether a capture of this type starts its own countdown automatically. */
  readonly autoSend: Readonly<Record<MediaType, boolean>>;
  /** How long the undo window lasts, in milliseconds. */
  readonly undoDelayMs: number;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  // PLAN.md: capture "with auto-send"; the guest opts out, not in.
  autoSend: { photo: true, video: true },
  undoDelayMs: DEFAULT_UNDO_DELAY_MS,
};

/** Whether a fresh capture of this type should start its countdown on its own. */
export function autoSendsFor(settings: CaptureSettings, mediaType: MediaType): boolean {
  return settings.autoSend[mediaType];
}

export function withAutoSend(
  settings: CaptureSettings,
  mediaType: MediaType,
  enabled: boolean,
): CaptureSettings {
  return { ...settings, autoSend: { ...settings.autoSend, [mediaType]: enabled } };
}

export function withUndoDelay(settings: CaptureSettings, delayMs: number): CaptureSettings {
  return { ...settings, undoDelayMs: normaliseDelayMs(delayMs) };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerce anything at all into usable settings.
 *
 * `MEDIA_TYPES` drives the loop rather than a literal `{ photo, video }` so that
 * adding a media type to the contract cannot leave a hole here — the record is
 * rebuilt from the contract's own list every time.
 */
export function normaliseCaptureSettings(raw: unknown): CaptureSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_CAPTURE_SETTINGS;
  const source = raw as Record<string, unknown>;

  const rawAutoSend =
    typeof source.autoSend === "object" && source.autoSend !== null
      ? (source.autoSend as Record<string, unknown>)
      : {};

  const autoSend = {} as Record<MediaType, boolean>;
  for (const mediaType of MEDIA_TYPES) {
    autoSend[mediaType] = readBoolean(
      rawAutoSend[mediaType],
      DEFAULT_CAPTURE_SETTINGS.autoSend[mediaType],
    );
  }

  return {
    autoSend,
    undoDelayMs:
      source.undoDelayMs === undefined
        ? DEFAULT_CAPTURE_SETTINGS.undoDelayMs
        : normaliseDelayMs(source.undoDelayMs),
  };
}

export function serialiseCaptureSettings(settings: CaptureSettings): string {
  return JSON.stringify(settings);
}

/** Parse the stored blob. `null`/malformed JSON is "never saved anything". */
export function parseCaptureSettings(raw: string | null | undefined): CaptureSettings {
  if (raw === null || raw === undefined || raw.length === 0) return DEFAULT_CAPTURE_SETTINGS;
  try {
    return normaliseCaptureSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAPTURE_SETTINGS;
  }
}

/** "15 seconds" / "off" / "1 minute" — the line under the slider. */
export function describeUndoDelay(delayMs: number): string {
  const ms = normaliseDelayMs(delayMs);
  if (ms === 0) return "Send immediately";
  if (ms >= 60_000) return "1 minute to undo";
  return `${Math.round(ms / 1000)} seconds to undo`;
}
