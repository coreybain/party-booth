/**
 * The tab shell's header: which party this phone is pointed at, and a way to change it.
 *
 * Rendered once, by `app/(tabs)/_layout.tsx`, as the navigator's `header`. Putting it
 * in the shell rather than in each screen is what makes it impossible for the Camera
 * tab and the Host tab to disagree about which event is active — a disagreement that
 * would mean a photo landing at the wrong party.
 *
 * It is deliberately a button, not a picker. The list, the "join another" entry point
 * and the empty state all live behind one route (`/events`), so there is one place
 * that knows how switching works.
 */

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { describeEventState } from "../lib/events";
import { useSession } from "../providers/session";
import { colors, radius, spacing, typography } from "../theme";

import type { EventTone } from "../lib/events";

/** State tone → palette. Kept here so `src/lib/events.ts` stays free of theme imports. */
const TONE_COLORS: Record<EventTone, string> = {
  live: colors.success,
  waiting: colors.warning,
  resting: colors.textFaint,
  closed: colors.textFaint,
};

export function EventHeader() {
  const router = useRouter();
  const { activeEvent, events, eventsLoading, configured } = useSession();
  const insets = useSafeAreaInsets();

  const description = activeEvent ? describeEventState(activeEvent.state) : null;
  const otherEvents = Math.max(events.length - 1, 0);

  const title = activeEvent?.name ?? (eventsLoading ? "Loading…" : "No party yet");
  const subtitle = description
    ? description.label
    : configured
      ? "Scan a QR or enter a code to join"
      : "Backend not configured";

  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          activeEvent
            ? `Active party: ${activeEvent.name}. ${description?.label ?? ""}. Change party.`
            : "Join a party"
        }
        accessibilityHint={
          otherEvents > 0
            ? `You are in ${events.length} parties.`
            : "Opens the list of parties you have joined."
        }
        onPress={() => router.push("/events")}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.subtitleRow}>
            {description ? (
              <View style={[styles.dot, { backgroundColor: TONE_COLORS[description.tone] }]} />
            ) : null}
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>

        {/* The count is only worth the pixels once there is actually a choice to make. */}
        {otherEvents > 0 ? (
          <View style={styles.count}>
            <Text style={styles.countLabel}>{`+${otherEvents}`}</Text>
          </View>
        ) : null}
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  button: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  buttonPressed: { opacity: 0.75 },
  text: { flex: 1, gap: 2 },
  title: { ...typography.heading, color: colors.text },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  subtitle: { ...typography.caption, color: colors.textMuted, flexShrink: 1 },
  count: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  countLabel: { ...typography.caption, color: colors.textMuted, fontWeight: "600" },
});
