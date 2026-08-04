/**
 * The parties subpage: switch, leave, join.
 *
 * Everything about "which party am I at" happens here: the list, the choice,
 * the way out and the way into another one. The choice is stored
 * **server-side** by `events.setActiveEvent`, not on the device — a host
 * running the party from their phone and presenting the slideshow from a
 * laptop should pick the party once.
 *
 * Leaving is here too, now that the list lives inside Settings rather than one
 * tap from every screen — but behind a native confirmation, and never for the
 * party's owner (`events.leave` refuses; their exit is deleting the party).
 * Leaving is reversible by the same door the guest came in through: a fresh
 * scan of a valid code re-activates the membership.
 */

import { Ionicons } from "@expo/vector-icons";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Badge, Button, EmptyState, Loading, MutedText, Notice, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { describeEvent, describeSchedule } from "@/lib/events";
import { captureHandledError } from "@/lib/sentry";
import { useNow } from "@/hooks/use-now";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

import type { EventSummary } from "@/lib/api";
import type { EventRole } from "@/lib/roles";

const ROLE_LABELS: Record<EventRole, string> = {
  owner: "Host",
  cohost: "Co-host",
  guest: "Guest",
};

export default function PartiesScreen() {
  const router = useRouter();
  const { events, activeEvent, eventsLoading, selectEvent, configured } = useSession();
  const leave = useMutation(api.events.leave);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const choose = useCallback(
    async (event: EventSummary) => {
      if (event.id === activeEvent?.id) return;
      setBusyId(event.id);
      setError(null);
      const outcome = await selectEvent(event.id);
      setBusyId(null);
      if (outcome.status === "error") setError(outcome.message);
    },
    [activeEvent?.id, selectEvent],
  );

  const confirmLeave = useCallback(
    (event: EventSummary) => {
      // The native alert, deliberately: leaving mid-party is rare and worth a
      // beat of friction, and this is the dialog iOS users already trust.
      Alert.alert(
        `Leave ${event.name}?`,
        "Your photos stay with the party. You can come back in any time by scanning its QR code or entering its join code again.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Leave",
            style: "destructive",
            onPress: () => {
              void (async () => {
                setBusyId(event.id);
                setError(null);
                try {
                  await leave({ eventId: event.id });
                } catch (caught) {
                  captureHandledError(caught, { scope: "settings.leaveEvent" });
                  setError(describeError(caught).message);
                } finally {
                  setBusyId(null);
                }
              })();
            },
          },
        ],
      );
    },
    [leave],
  );

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <MutedText>
          Pick the party your camera should send to. This follows your account, not this phone.
        </MutedText>

        {error ? (
          <Notice tone="danger" title="That didn't work">
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
                // The owner cannot leave their own party — an event without its
                // host is a party nobody can moderate or close.
                onLeave={event.role === "owner" ? null : () => confirmLeave(event)}
              />
            ))}
          </View>
        )}

        <Button
          label="Scan a QR code"
          icon="scan-outline"
          variant={events.length === 0 ? "primary" : "secondary"}
          onPress={() => router.push("/join/scan")}
          disabled={!configured}
          accessibilityHint="Opens the camera to scan the QR code on the host's sign."
        />

        <Button
          label="Enter a join code"
          icon="keypad-outline"
          variant="secondary"
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
  onLeave,
}: {
  event: EventSummary;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  now: number;
  onPress: () => void;
  /** `null` for the owner, who cannot leave their own party. */
  onLeave: (() => void) | null;
}) {
  const description = describeEvent(event, now);

  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: active, disabled, busy }}
        accessibilityLabel={`${event.name}. ${ROLE_LABELS[event.role]}. ${description.label}.`}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.rowMain,
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

      {onLeave === null ? null : (
        <>
          <View style={styles.rowDivider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Leave ${event.name}`}
            accessibilityHint="Asks you to confirm first. Your photos stay with the party."
            disabled={disabled}
            onPress={onLeave}
            style={({ pressed }) => [
              styles.leave,
              pressed && styles.rowPressed,
              disabled && !busy && styles.rowDisabled,
            ]}
          >
            <Text style={styles.leaveLabel}>Leave this party</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  loadingBlock: { height: 160 },
  list: { gap: spacing.sm },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  rowActive: { borderColor: colors.accent },
  rowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  rowDisabled: { opacity: 0.5 },
  rowText: { flex: 1, gap: spacing.xs },
  rowTitle: { ...typography.heading, color: colors.text },
  rowBadges: { flexDirection: "row", gap: spacing.sm, paddingTop: spacing.xs },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  leave: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  leaveLabel: { ...typography.body, color: colors.danger },
});
