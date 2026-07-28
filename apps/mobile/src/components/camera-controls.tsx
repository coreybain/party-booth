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
 * The shutter.
 *
 * `onLongPress` is wired to a "coming soon" affordance rather than left off, so
 * the gesture a guest will absolutely try — hold for video — answers rather than
 * doing nothing. Video capture is Sprint 4 (PLAN.md → Sprint 4, "hold-to-record
 * (≤60 s)"); the pipeline underneath is already type-agnostic, so what lands
 * then is a recorder, not a second queue.
 */
export function ShutterButton({
  onPress,
  onHold,
  disabled = false,
  busy = false,
}: {
  onPress: () => void;
  onHold: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Take a photo"
      accessibilityHint="Hold for video — coming soon."
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      onLongPress={onHold}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.shutter,
        pressed && styles.shutterPressed,
        (disabled || busy) && styles.disabled,
      ]}
    >
      <View style={[styles.shutterCore, busy && styles.shutterCoreBusy]} />
    </Pressable>
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
  shutterCore: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
  },
  shutterCoreBusy: { backgroundColor: colors.textFaint },
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
