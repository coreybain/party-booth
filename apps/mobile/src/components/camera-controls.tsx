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
 * A conic gradient would be nicer and needs Skia. What is here is four absolutely
 * positioned edges whose *opacity* is driven by progress — a sweep that reads
 * correctly at a glance from across a room, redrawn ~20 times a second, costing
 * one extra dependency of zero. The precise second count is spoken by the label
 * next to it, which is what anybody actually reads.
 */
export function ShutterButton({
  onPressIn,
  onPressOut,
  recording = false,
  progress = 0,
  disabled = false,
  busy = false,
  videoEnabled = true,
}: {
  onPressIn: () => void;
  onPressOut: () => void;
  /** True from the moment the recorder starts until the file is closed. */
  recording?: boolean;
  /** 0–1 of the 60-second cap. */
  progress?: number;
  disabled?: boolean;
  busy?: boolean;
  /** False when the party is photo-only; the hint and the label drop the hold. */
  videoEnabled?: boolean;
}) {
  const inactive = disabled || busy;
  const clamped = Math.min(1, Math.max(0, progress));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? "Stop recording" : "Take a photo"}
      accessibilityHint={
        videoEnabled ? "Tap for a photo. Hold to record a video, up to 60 seconds." : undefined
      }
      accessibilityState={{ disabled: inactive, busy }}
      // A live progress value on the button itself, so a screen reader user gets
      // the same "how much is left" a sighted guest gets from the ring.
      accessibilityValue={
        recording ? { now: Math.round(clamped * 100), min: 0, max: 100 } : undefined
      }
      disabled={inactive}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        styles.shutter,
        recording && styles.shutterRecording,
        pressed && !recording && styles.shutterPressed,
        inactive && styles.disabled,
      ]}
    >
      {recording ? <RecordingRing progress={clamped} /> : null}
      <View
        style={[
          styles.shutterCore,
          busy && styles.shutterCoreBusy,
          // A filled circle becomes a rounded square while recording — the
          // universal "stop" affordance, and the one shape change that reads at
          // arm's length in a dark room.
          recording && styles.shutterCoreRecording,
        ]}
      />
    </Pressable>
  );
}

/**
 * The 60-second sweep, as four fading edges.
 *
 * Each quarter of the ring lights over its own quarter of the progress, so the
 * band travels clockwise from the top. Not a true arc — it is four straight
 * segments — which is invisible at 76 px and is the difference between shipping
 * this and adding a rendering dependency in launch week.
 */
function RecordingRing({ progress }: { progress: number }) {
  const quarter = (index: number) => Math.min(1, Math.max(0, progress * 4 - index));
  return (
    <View style={styles.ring} pointerEvents="none">
      <View style={[styles.ringEdge, styles.ringTop, { opacity: quarter(0) }]} />
      <View style={[styles.ringEdge, styles.ringRight, { opacity: quarter(1) }]} />
      <View style={[styles.ringEdge, styles.ringBottom, { opacity: quarter(2) }]} />
      <View style={[styles.ringEdge, styles.ringLeft, { opacity: quarter(3) }]} />
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
    width: 76,
    height: 76,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: colors.text,
    backgroundColor: "rgba(18, 9, 27, 0.35)",
  },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  shutterRecording: { borderColor: colors.danger },
  shutterCore: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
  },
  shutterCoreBusy: { backgroundColor: colors.textFaint },
  shutterCoreRecording: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.danger,
  },
  ring: {
    position: "absolute",
    top: -6,
    left: -6,
    right: -6,
    bottom: -6,
    borderRadius: radius.pill,
  },
  ringEdge: { position: "absolute", backgroundColor: colors.danger },
  ringTop: { top: 0, left: "25%", right: "25%", height: 3, borderRadius: radius.pill },
  ringRight: { right: 0, top: "25%", bottom: "25%", width: 3, borderRadius: radius.pill },
  ringBottom: { bottom: 0, left: "25%", right: "25%", height: 3, borderRadius: radius.pill },
  ringLeft: { left: 0, top: "25%", bottom: "25%", width: 3, borderRadius: radius.pill },
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
