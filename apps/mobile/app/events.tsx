import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  Badge,
  Button,
  EmptyState,
  Loading,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { useNow } from "@/hooks/use-now";
import { describeEventState, describeSchedule } from "@/lib/events";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

import type { EventSummary } from "@/lib/api";
import type { EventRole } from "@/lib/roles";

/**
 * The event switcher.
 *
 * Everything about "which party am I at" happens here: the list, the choice, and the
 * way to join another one. The choice is stored **server-side** by
 * `events.setActiveEvent`, not on the device — a host running the party from their
 * phone and presenting the slideshow from a laptop should pick the party once.
 *
 * There is no "leave" or "delete" here on purpose. Both are destructive and belong
 * behind the event's own settings with a confirmation, not one tap away from a list
 * a guest opens to switch tabs.
 */

const ROLE_LABELS: Record<EventRole, string> = {
  owner: "Host",
  cohost: "Co-host",
  guest: "Guest",
};

export default function EventsRoute() {
  const router = useRouter();
  const { events, activeEvent, eventsLoading, selectEvent, configured } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const choose = useCallback(
    async (event: EventSummary) => {
      if (event.id === activeEvent?.id) {
        router.back();
        return;
      }
      setBusyId(event.id);
      setError(null);
      const outcome = await selectEvent(event.id);
      setBusyId(null);
      if (outcome.status === "error") {
        setError(outcome.message);
        return;
      }
      router.back();
    },
    [activeEvent?.id, router, selectEvent],
  );

  return (
    <Screen edges={["left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Your parties"
          subtitle="Pick the one your camera should send to. This follows your account, not this phone."
        />

        {error ? (
          <Notice tone="danger" title="Couldn't switch">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        {eventsLoading ? (
          // `Loading` is `flex: 1`, which collapses to zero height inside a scroll
          // view's content container. The fixed block gives it something to fill.
          <View style={styles.loadingBlock}>
            <Loading label="Finding your parties…" />
          </View>
        ) : events.length === 0 ? (
          <EmptyState
            icon="qr-code-outline"
            title="You haven't joined a party yet"
            body="Scan the QR code on the host's sign, or type the six-digit code printed under it."
          />
        ) : (
          <View style={styles.list}>
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                active={event.id === activeEvent?.id}
                busy={busyId === event.id}
                disabled={busyId !== null}
                now={now}
                onPress={() => void choose(event)}
              />
            ))}
          </View>
        )}

        <Button
          label="Enter a join code"
          icon="keypad-outline"
          variant={events.length === 0 ? "primary" : "secondary"}
          onPress={() => router.push("/join")}
          disabled={!configured}
          accessibilityHint="Opens the six-digit code screen."
        />

        {!configured ? (
          <Notice tone="warning" title="Running without a backend">
            <MutedText>
              No Convex deployment is configured in this build, so there are no parties to list.
            </MutedText>
          </Notice>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function EventRow({
  event,
  active,
  busy,
  disabled,
  now,
  onPress,
}: {
  event: EventSummary;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  now: number;
  onPress: () => void;
}) {
  const description = describeEventState(event.state);

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active, disabled, busy }}
      accessibilityLabel={`${event.name}. ${ROLE_LABELS[event.role]}. ${description.label}.`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && styles.rowPressed,
        disabled && !busy && styles.rowDisabled,
      ]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {event.name}
        </Text>
        <MutedText>{describeSchedule(event, now)}</MutedText>
        <View style={styles.rowBadges}>
          <Badge label={description.label} tone={active ? colors.accent : colors.textFaint} />
          {/* Only worth saying when it is not the default. Every guest is a guest. */}
          {event.role === "guest" ? null : <Badge label={ROLE_LABELS[event.role]} />}
        </View>
      </View>

      {busy ? (
        <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
      ) : active ? (
        <Ionicons name="checkmark-circle" size={22} color={colors.accent} />
      ) : (
        <Ionicons name="ellipse-outline" size={22} color={colors.textFaint} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  loadingBlock: { height: 160 },
  list: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowActive: { borderColor: colors.accent },
  rowPressed: { opacity: 0.75 },
  rowDisabled: { opacity: 0.5 },
  rowText: { flex: 1, gap: spacing.xs },
  rowTitle: { ...typography.heading, color: colors.text },
  rowBadges: { flexDirection: "row", gap: spacing.sm, paddingTop: spacing.xs },
});
