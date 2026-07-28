/**
 * The undo window, on screen.
 *
 * A thumbnail of what was just taken, how long is left, and the two things a
 * guest can do about it. It sits over the viewfinder so the next shot is never
 * blocked by the last one — a party moves faster than a confirmation dialog.
 *
 * The bar is a plain `View` with a percentage width rather than an animated SVG
 * ring: it re-renders four times a second from `useNow(COUNTDOWN_TICK_MS)`,
 * which is smooth enough to read as motion and costs no new dependency in a
 * week where a new dependency is a risk.
 *
 * Two shapes, one component, because they are the same moment:
 *
 * - **Auto-send on** — a countdown, an Undo button, and "Send now" for the
 *   impatient.
 * - **Auto-send off** — no countdown at all; Send and Discard, and it waits.
 */

import { Image } from "expo-image";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useNow } from "../hooks/use-now";
import { COUNTDOWN_TICK_MS, countdownProgress, remainingSeconds } from "../upload/countdown";
import { colors, radius, spacing, typography } from "../theme";

import type { QueueItem } from "../upload/types";

export function UndoPill({
  item,
  onUndo,
  onSendNow,
}: {
  item: QueueItem;
  onUndo: () => void;
  onSendNow: () => void;
}) {
  const now = useNow(COUNTDOWN_TICK_MS);
  const seconds = remainingSeconds(item.sendAt, now);
  const progress = countdownProgress(item.sendAt, item.undoDelayMs, now);

  const headline = item.autoSend
    ? seconds > 0
      ? `Sending in ${seconds}s`
      : "Sending…"
    : "Ready to send";

  return (
    <View style={styles.pill} accessibilityLiveRegion="polite">
      <Image
        source={{ uri: item.previewUri }}
        style={styles.thumb}
        contentFit="cover"
        transition={120}
        accessibilityIgnoresInvertColors
      />

      <View style={styles.body}>
        <Text style={styles.headline}>{headline}</Text>
        {item.autoSend ? (
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityValue={{ now: Math.round(progress * 100), min: 0, max: 100 }}
          >
            <View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
        ) : (
          <Text style={styles.hint}>Auto-send is off for photos.</Text>
        )}
      </View>

      <View style={styles.actions}>
        <PillAction
          label={item.autoSend ? "Undo" : "Discard"}
          tone="danger"
          onPress={onUndo}
          hint="Deletes this photo from your phone. It is never sent."
        />
        <PillAction label="Send" tone="accent" onPress={onSendNow} hint="Sends it straight away." />
      </View>
    </View>
  );
}

function PillAction({
  label,
  tone,
  onPress,
  hint,
}: {
  label: string;
  tone: "accent" | "danger";
  onPress: () => void;
  hint: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        tone === "accent" ? styles.actionAccent : styles.actionDanger,
        pressed && styles.actionPressed,
      ]}
    >
      <Text
        style={[styles.actionLabel, { color: tone === "accent" ? colors.onAccent : colors.danger }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: "rgba(18, 9, 27, 0.88)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
  },
  body: { flex: 1, gap: spacing.xs },
  headline: { ...typography.label, color: colors.text },
  hint: { ...typography.caption, color: colors.textMuted },
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  fill: { height: 4, borderRadius: radius.pill, backgroundColor: colors.accent },
  actions: { flexDirection: "row", gap: spacing.xs },
  action: {
    minHeight: 40,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionAccent: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionDanger: { backgroundColor: "transparent", borderColor: colors.danger },
  actionPressed: { opacity: 0.75 },
  actionLabel: { ...typography.label },
});
