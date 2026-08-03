/**
 * Notification preferences — per-category toggles and the host threshold.
 *
 * ## Why an opt-**out** list
 *
 * The server stores the categories a person has switched *off*, not a boolean
 * per category (`@partybooth/contracts/push`). So a category this build has
 * never heard of stays on, and a category added next month defaults to on for
 * everybody without a migration. The list of categories therefore comes from the
 * **server** (`push.preferences.categories`) rather than from this bundle: an
 * older app must not silently hide a toggle it cannot name, and it must not send
 * an opt-out array that drops one.
 *
 * ## Why the host toggle is conditional
 *
 * `hostPendingThreshold` is meaningless to somebody who hosts nothing, and a
 * dead switch in a settings screen is worse than no switch. The *preference* is
 * still stored for everybody — a guest who becomes a co-host tomorrow should not
 * inherit "on" because nobody ever asked them — so this hides the control, never
 * the value.
 *
 * ## Why there is a button at all
 *
 * iOS gives an app one system prompt per install and the app spends it after the
 * first join (see `src/push/registration.ts`). Somebody who declined then, or
 * who joined before this build existed, needs a way back that is not
 * "reinstall" — so a refused permission offers the system settings page, and an
 * un-asked one offers the prompt.
 */

import {
  HOST_ONLY_PUSH_CATEGORIES,
  PUSH_CATEGORY_COPY,
  type PushCategory,
} from "@partybooth/contracts/push";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { BodyText, Button, MutedText, Notice, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { appConfig } from "@/env";
import { describeError } from "@/lib/errors";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { usePush } from "@/push/provider";
import { colors, radius, spacing, typography } from "@/theme";

export default function NotificationsScreen() {
  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <NotificationsSection />
      </ScrollView>
    </Screen>
  );
}

function NotificationsSection() {
  const { events } = useSession();
  const { permission, registered, enableNotifications } = usePush();
  const preferences = useQuery(api.push.preferences, {});
  const updatePreferences = useMutation(api.push.updatePreferences);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = events.some((event) => event.role === "owner" || event.role === "cohost");
  const pushAvailable = appConfig.status === "ready" && appConfig.features.push;

  const save = useCallback(
    async (patch: { optOut?: PushCategory[]; pendingThreshold?: number }): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await updatePreferences(patch);
      } catch (caught) {
        captureHandledError(caught, { scope: "settings.notificationPreferences" });
        setError(describeError(caught).message);
      } finally {
        setBusy(false);
      }
    },
    [updatePreferences],
  );

  if (!pushAvailable) {
    return (
      <MutedText>
        This build has no Expo project configured, so it cannot receive notifications. Nothing is
        lost — the app still tells you about uploads and the queue while it is open.
      </MutedText>
    );
  }

  const optOut = preferences?.optOut ?? [];
  const categories = (preferences?.categories ?? []).filter(
    (category) => hosts || !(HOST_ONLY_PUSH_CATEGORIES as readonly string[]).includes(category),
  );

  return (
    <>
      {permission === "granted" ? null : (
        <>
          <MutedText>
            {permission === "denied"
              ? "Notifications are switched off for PartyBooth in your phone's settings. The switches below are remembered either way."
              : "PartyBooth will ask for permission the first time you join a party. You can also turn them on now."}
          </MutedText>
          <Button
            label={permission === "denied" ? "Open phone settings" : "Turn on notifications"}
            variant="secondary"
            icon="notifications-outline"
            onPress={() => {
              if (permission === "denied") void openSystemSettings();
              else void enableNotifications();
            }}
          />
        </>
      )}

      {preferences === undefined ? (
        <MutedText>Loading…</MutedText>
      ) : (
        <>
          {categories.map((category) => {
            const copy = PUSH_CATEGORY_COPY[category];
            const on = !optOut.includes(category);
            return (
              <View key={category} style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <BodyText>{copy.title}</BodyText>
                  <MutedText>{copy.description}</MutedText>
                </View>
                <Switch
                  value={on}
                  disabled={busy}
                  onValueChange={(next) => {
                    // Sent as the whole opt-out list rather than a delta,
                    // because that is what the mutation takes — but only this
                    // field is sent, so a second phone changing the threshold at
                    // the same moment does not have its change reverted.
                    const nextOptOut = next
                      ? optOut.filter((entry) => entry !== category)
                      : [...optOut, category];
                    void save({ optOut: [...nextOptOut] });
                  }}
                  trackColor={{ true: colors.accent, false: colors.border }}
                  accessibilityLabel={copy.title}
                />
              </View>
            );
          })}

          {hosts ? (
            <ThresholdPicker
              value={preferences.pendingThreshold}
              disabled={busy}
              onChange={(pendingThreshold) => void save({ pendingThreshold })}
            />
          ) : null}

          {registered ? null : (
            <MutedText>
              This phone is not registered for notifications yet. It registers itself the next time
              you open the app with permission granted.
            </MutedText>
          )}
        </>
      )}

      {error !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}
    </>
  );
}

/**
 * How full the queue gets before a host's phone buzzes.
 *
 * Presets rather than a slider or a number field: the difference between 5 and 6
 * is noise, the difference between 5 and 20 is a different kind of party, and
 * nobody types into a settings field while holding a drink. The bounds are the
 * contract's (1–100); these are the useful points inside them.
 */
const THRESHOLD_OPTIONS = [3, 5, 10, 20, 50] as const;

function ThresholdPicker({
  value,
  disabled,
  onChange,
}: {
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <View style={styles.thresholdBlock}>
      <BodyText>Tell me when this many are waiting</BodyText>
      <MutedText>
        Only while you are hosting. A rush of thirty photos in one minute is one buzz, not thirty.
      </MutedText>
      <View style={styles.thresholdRow}>
        {THRESHOLD_OPTIONS.map((option) => {
          const active = option === value;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled }}
              accessibilityLabel={`Notify me at ${String(option)} waiting`}
              disabled={disabled}
              onPress={() => onChange(option)}
              style={[styles.threshold, active && styles.thresholdActive]}
            >
              <Text style={[styles.thresholdLabel, active && styles.thresholdLabelActive]}>
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Take the guest to the OS page where a refused permission can be undone.
 *
 * `Linking.openSettings()` lands on this app's own settings on both platforms.
 * Use the normal named React Native import. A dynamic namespace import makes
 * Expo's async loader enumerate every legacy React Native getter, including
 * `PushNotificationIOS`, which is not present in modern native builds.
 */
async function openSystemSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (error) {
    captureHandledError(error, { scope: "settings.openSystemSettings" });
  }
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  switchCopy: { flex: 1, gap: spacing.xs },
  thresholdBlock: { gap: spacing.xs },
  thresholdRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  threshold: {
    minWidth: 48,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
  },
  thresholdActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  thresholdLabel: { ...typography.label, color: colors.textMuted },
  thresholdLabelActive: { color: colors.onAccent },
});
