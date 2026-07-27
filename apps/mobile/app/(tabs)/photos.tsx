import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { EmptyState, Screen, ScreenHeader } from "@/components/ui";
import { colors, radius, spacing, typography } from "@/theme";

/**
 * Photos tab — "My media" and "Event gallery" empty states.
 *
 * Both lists become live Convex subscriptions: My media in Sprint 3 (status, retry,
 * cancel, withdraw), the approved Event gallery in Sprint 4.
 */

const SEGMENTS = [
  { key: "mine", label: "My media" },
  { key: "event", label: "Event gallery" },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]["key"];

export default function PhotosScreen() {
  const [segment, setSegment] = useState<SegmentKey>("mine");

  return (
    <Screen>
      <ScreenHeader title="Photos" />

      <View style={styles.segmented} accessibilityRole="tablist">
        {SEGMENTS.map((item) => {
          const active = item.key === segment;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setSegment(item.key)}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {segment === "mine" ? (
          <EmptyState
            icon="cloud-upload-outline"
            title="Nothing sent yet"
            body="Everything you capture shows up here with its moderation status. You can retry a failed upload, or withdraw something you'd rather the host didn't see."
          />
        ) : (
          <EmptyState
            icon="images-outline"
            title="No approved media yet"
            body="Once the host approves submissions, the whole party's photos and videos appear here — and update live as they land."
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xs,
    gap: spacing.xs,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  segmentActive: { backgroundColor: colors.surfaceRaised },
  segmentLabel: { ...typography.label, color: colors.textFaint },
  segmentLabelActive: { color: colors.text },
  content: { paddingTop: spacing.xl },
});
