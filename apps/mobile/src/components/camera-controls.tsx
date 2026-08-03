/**
 * The controls that sit over the viewfinder.
 *
 * Split out of `app/(tabs)/camera.tsx` so the screen reads as "permissions,
 * viewfinder, controls, undo" rather than as three hundred lines of `Pressable`.
 * Everything here is presentational — no camera, no queue, no navigation.
 *
 * Two things are deliberate:
 *
 * - **Every control is at least 48 px.** These are pressed one-handed, at night,
 *   by someone holding a drink.
 * - **Nothing rotates itself.** The app allows both orientations
 *   (`orientation: "default"`), so the whole UI turns with the device and the
 *   *layout* moves the controls to the short edge. Counter-rotating icons inside
 *   a rotating view is how you end up with labels upside down.
 */

import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../theme";

import type { ComponentProps } from "react";
import type { GestureResponderEvent, ViewStyle } from "react-native";

type IconName = ComponentProps<typeof Ionicons>["name"];

/** The three flash modes PLAN.md asks for, in the order the button cycles them. */
export const FLASH_MODES = ["off", "auto", "on"] as const;

export type FlashMode = (typeof FLASH_MODES)[number];

const FLASH_ICONS: Record<FlashMode, IconName> = {
  off: "flash-off-outline",
  auto: "flash-outline",
  on: "flash",
};

const FLASH_LABELS: Record<FlashMode, string> = {
  off: "Flash off",
  auto: "Flash automatic",
  on: "Flash on",
};

export function nextFlashMode(current: FlashMode): FlashMode {
  const index = FLASH_MODES.indexOf(current);
  return FLASH_MODES[(index + 1) % FLASH_MODES.length] ?? "off";
}

/* -------------------------------------------------------------------------- */

function RoundButton({
  icon,
  label,
  onPress,
  disabled = false,
  active = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.round,
        active && styles.roundActive,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={22} color={active ? colors.onAccent : colors.text} />
    </Pressable>
  );
}

export function FlashButton({
  mode,
  onChange,
  disabled,
}: {
  mode: FlashMode;
  onChange: (next: FlashMode) => void;
  disabled?: boolean;
}) {
  return (
    <RoundButton
      icon={FLASH_ICONS[mode]}
      label={FLASH_LABELS[mode]}
      active={mode !== "off"}
      disabled={disabled ?? false}
      onPress={() => onChange(nextFlashMode(mode))}
    />
  );
}

export function FlipButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <RoundButton
      icon="camera-reverse-outline"
      label="Switch between the front and back camera"
      disabled={disabled ?? false}
      onPress={onPress}
    />
  );
}

export function LibraryButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <RoundButton
      icon="images-outline"
      label="Add a photo from your library"
      disabled={disabled ?? false}
      onPress={onPress}
    />
  );
}

/**
 * Torch — the video-mode equivalent of the flash.
 *
 * `flash` on `CameraView` fires the strobe for a *still*; it does nothing at all
 * during `recordAsync`. A guest who set the flash to "on" and then holds for
 * video in a dark room would otherwise get a black clip and no explanation, so
 * this is a separate control with its own state, shown only while video is on
 * the table. It is never left on: the camera screen clears it when a recording
 * ends, when the tab loses focus, and when the camera unmounts.
 */
export function TorchButton({
  on,
  onToggle,
  disabled,
}: {
  on: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <RoundButton
      icon={on ? "flashlight" : "flashlight-outline"}
      label={on ? "Turn the light off" : "Turn the light on for video"}
      active={on}
      disabled={disabled ?? false}
      onPress={() => onToggle(!on)}
    />
  );
}

/**
 * The shutter: tap for a photograph, hold for a video.
 *
 * ## Why this is not `onPress` + `onLongPress`
 *
 * React Native's `onLongPress` fires once, after `delayLongPress`, and gives you
 * no signal at all when the finger lifts — which is the one event a
 * hold-to-record button is entirely about. Worse, `onPress` fires on release
 * *even after* a long press on some platforms, so a recording would end with a
 * photograph being taken too.
 *
 * So the gesture is driven from `onPressIn` / `onPressOut` and decided by
 * {@link ShutterState} in `src/lib/shutter.ts`, which is a pure reducer and is
 * unit-tested in Node. This component draws the result and nothing else: it does
 * not know what 250 ms means, or what 60 seconds means, or which of the two the
 * current press is going to turn out to be.
 *
 * ## The ring
 *
 * Sixty fixed ticks make elapsed time spatial: one turns red for every second
 * recorded, while the centre counts down. Only opacity changes as the clock
 * advances, keeping the interaction cheap enough to share a frame with the
 * native camera preview and avoiding another rendering dependency.
 */
export function ShutterButton({
  onPressIn,
  onPressMove,
  onPressOut,
  recording = false,
  progress = 0,
  remaining = 60,
  zoom = 0,
  disabled = false,
  busy = false,
  videoEnabled = true,
}: {
  onPressIn: (event: GestureResponderEvent) => void;
  onPressMove?: ((event: GestureResponderEvent) => void) | undefined;
  onPressOut: () => void;
  /** True from the moment the recorder starts until the file is closed. */
  recording?: boolean;
  /** 0–1 of the 60-second cap. */
  progress?: number;
  /** Whole seconds left, shown inside the shutter while recording. */
  remaining?: number;
  /** Native camera zoom, 0–1. Drives the drag feedback rail. */
  zoom?: number;
  disabled?: boolean;
  busy?: boolean;
  /** False when the party is photo-only; the hint and the label drop the hold. */
  videoEnabled?: boolean;
}) {
  const inactive = disabled || busy;
  const clamped = Math.min(1, Math.max(0, progress));
  const clampedZoom = Math.min(1, Math.max(0, zoom));
  const countdown = Math.max(0, Math.min(60, Math.ceil(remaining)));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? "Stop recording" : "Take a photo"}
      accessibilityHint={
        videoEnabled
          ? "Tap for a photo. Hold to record up to 60 seconds; slide up or down to zoom."
          : undefined
      }
      accessibilityState={{ disabled: inactive, busy }}
      // A live progress value on the button itself, so a screen reader user gets
      // the same "how much is left" a sighted guest gets from the ring.
      accessibilityValue={
        recording
          ? {
              now: Math.round(clamped * 100),
              min: 0,
              max: 100,
              text: `${String(countdown)} seconds remaining`,
            }
          : undefined
      }
      disabled={inactive}
      onPressIn={onPressIn}
      onPressMove={onPressMove}
      onPressOut={onPressOut}
      pressRetentionOffset={{ top: 280, bottom: 280, left: 96, right: 96 }}
      style={({ pressed }) => [
        styles.shutter,
        recording && styles.shutterRecording,
        pressed && !recording && styles.shutterPressed,
        inactive && styles.disabled,
      ]}
    >
      {recording ? <RecordingRing progress={clamped} /> : null}
      {recording ? <ZoomRail zoom={clampedZoom} /> : null}
      <View
        style={[
          styles.shutterCore,
          busy && styles.shutterCoreBusy,
          recording && styles.shutterCoreRecording,
        ]}
      >
        {recording ? (
          <Text
            style={styles.shutterCountdown}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {countdown}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Sixty ticks, one for every second available to the clip.
 *
 * Their geometry is calculated once at module load; recording only changes
 * opacity, so the 20 fps clock never animates layout or asks the native camera
 * thread to share time with a rendering dependency.
 */
const RECORDING_RING_SIZE = 88;
const RECORDING_RING_SEGMENT_COUNT = 60;
const RECORDING_RING_SEGMENT_WIDTH = 2;
const RECORDING_RING_SEGMENT_HEIGHT = 6;
const RECORDING_RING_RADIUS = 41;
const RECORDING_RING_CENTER = RECORDING_RING_SIZE / 2;
const SHUTTER_SIZE = 76;
const SHUTTER_BORDER_WIDTH = 4;
// Absolute children are laid out from inside the parent's border on native.
// Include that inset so the red ring and visible white shutter are concentric.
export const RECORDING_RING_OFFSET = -(
  (RECORDING_RING_SIZE - SHUTTER_SIZE) / 2 +
  SHUTTER_BORDER_WIDTH
);

const RECORDING_RING_SEGMENTS: readonly ViewStyle[] = Array.from(
  { length: RECORDING_RING_SEGMENT_COUNT },
  (_, index): ViewStyle => {
    const angle = (index / RECORDING_RING_SEGMENT_COUNT) * Math.PI * 2;
    return {
      left:
        RECORDING_RING_CENTER +
        Math.sin(angle) * RECORDING_RING_RADIUS -
        RECORDING_RING_SEGMENT_WIDTH / 2,
      top:
        RECORDING_RING_CENTER -
        Math.cos(angle) * RECORDING_RING_RADIUS -
        RECORDING_RING_SEGMENT_HEIGHT / 2,
      transform: [{ rotate: `${String(index * 6)}deg` }],
    };
  },
);

function RecordingRing({ progress }: { progress: number }) {
  const activeSegments = Math.ceil(progress * RECORDING_RING_SEGMENT_COUNT);
  return (
    <View style={styles.ring} testID="recording-progress">
      {RECORDING_RING_SEGMENTS.map((segment, index) => (
        <View
          // Geometry is stable and index is the segment's identity.
          key={index}
          style={[styles.ringSegment, segment, index < activeSegments && styles.ringSegmentActive]}
        />
      ))}
    </View>
  );
}

/** A quiet spatial cue for the held vertical zoom gesture. */
function ZoomRail({ zoom }: { zoom: number }) {
  return (
    <View
      style={styles.zoomRail}
      testID="recording-zoom"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.zoomThumb, { transform: [{ translateY: 20 - zoom * 40 }] }]} />
    </View>
  );
}

/**
 * "REC 0:07 · 53s left" — the readout beside the shutter while recording.
 *
 * Separate from the ring because it is the precise information and the ring is
 * the glanceable one, and because `accessibilityLiveRegion` on a component that
 * re-renders twenty times a second would make a screen reader unusable — this
 * one changes only when the whole second does.
 */
export function RecordingIndicator({ seconds, remaining }: { seconds: number; remaining: number }) {
  return (
    <View style={styles.recording} accessibilityRole="text">
      <View style={styles.recordingDot} />
      <Text style={styles.recordingLabel}>
        {`0:${String(seconds).padStart(2, "0")}`}
        {/* Only once it is worth saying. Counting down from 60 the whole time
            makes a party feel like an exam. */}
        {remaining <= 10 ? ` · ${String(remaining)}s left` : ""}
      </Text>
    </View>
  );
}

/** "3 sending" — the one number a guest wants while the queue is working. */
export function PendingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <View style={styles.pending} accessibilityRole="text">
      <Ionicons name="cloud-upload-outline" size={14} color={colors.onAccent} />
      <Text style={styles.pendingLabel}>{count === 1 ? "1 sending" : `${count} sending`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  round: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    // Translucent rather than solid: the viewfinder behind a control is what
    // tells you the control belongs to the camera.
    backgroundColor: "rgba(18, 9, 27, 0.55)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  roundActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  shutter: {
    width: SHUTTER_SIZE,
    height: SHUTTER_SIZE,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: SHUTTER_BORDER_WIDTH,
    borderColor: colors.text,
    backgroundColor: "rgba(18, 9, 27, 0.35)",
  },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  shutterRecording: {
    borderColor: "rgba(255, 244, 249, 0.25)",
    backgroundColor: "rgba(18, 9, 27, 0.62)",
  },
  shutterCore: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
  },
  shutterCoreBusy: { backgroundColor: colors.textFaint },
  shutterCoreRecording: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 244, 249, 0.08)",
  },
  shutterCountdown: { ...typography.title, color: colors.text, fontVariant: ["tabular-nums"] },
  ring: {
    position: "absolute",
    top: RECORDING_RING_OFFSET,
    left: RECORDING_RING_OFFSET,
    width: RECORDING_RING_SIZE,
    height: RECORDING_RING_SIZE,
    borderRadius: radius.pill,
    pointerEvents: "none",
  },
  ringSegment: {
    position: "absolute",
    width: RECORDING_RING_SEGMENT_WIDTH,
    height: RECORDING_RING_SEGMENT_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    opacity: 0.18,
  },
  ringSegmentActive: { opacity: 1 },
  zoomRail: {
    position: "absolute",
    right: -24,
    width: 3,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255, 244, 249, 0.22)",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  zoomThumb: {
    width: 9,
    height: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
  },
  recording: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.75)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  recordingDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.danger },
  recordingLabel: { ...typography.caption, fontWeight: "700", color: colors.text },
  pending: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  pendingLabel: { ...typography.caption, fontWeight: "700", color: colors.onAccent },
});
