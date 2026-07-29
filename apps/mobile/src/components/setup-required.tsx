/**
 * Shown when the app has no backend configuration.
 *
 * This is the offline/no-credentials state described in the repo constraints: the app
 * must build and run before Convex, Better Auth, Resend, Sentry or UploadThing exist.
 * Rather than a stack trace, the user (which at this point means a developer) gets the
 * exact variable names, where each value comes from, and where to put it.
 */

import { ScrollView, StyleSheet, Text, View } from "react-native";

import { envHintFor } from "../env";
import { colors, radius, spacing, typography } from "../theme";
import { Badge, BodyText, Button, Card, MonoText, MutedText, Screen, ScreenHeader } from "./ui";

export function SetupRequired({
  missing,
  onContinueAnyway,
  title = "PartyBooth isn't configured",
  subtitle = "The app built fine — it just has no backend to talk to yet.",
}: {
  missing: readonly string[];
  /**
   * Omitted where there is no shell worth exploring — a deep-linked join screen
   * has nothing to fall through to, and offering the escape hatch there just
   * lands the guest on this same screen again.
   */
  onContinueAnyway?: (() => void) | undefined;
  title?: string;
  subtitle?: string;
}) {
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader title={title} subtitle={subtitle} />

        <Card>
          <Badge label="missing config" tone={colors.warning} />
          <BodyText>
            Add the values below to <MonoText>apps/mobile/.env.local</MonoText>, then restart the
            dev server. Expo only reads env files at bundle time, so a reload is not enough.
          </BodyText>
        </Card>

        <View style={styles.list}>
          {missing.map((key) => (
            <View key={key} style={styles.item}>
              <Text style={styles.itemKey}>{key}</Text>
              <Text style={styles.itemHint}>
                {envHintFor(key) ?? "See .env.example at the repo root."}
              </Text>
            </View>
          ))}
        </View>

        <Card>
          <MutedText>
            Run <MonoText>bun run env:doctor</MonoText> from the repo root for the full list of
            variables, including the optional ones (Sentry, push notifications).
          </MutedText>
        </Card>

        {onContinueAnyway ? (
          <Button
            label="Explore the shell anyway"
            variant="secondary"
            icon="arrow-forward"
            onPress={onContinueAnyway}
            accessibilityHint="Opens the app's navigation shell with every backend feature disabled."
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  list: { gap: spacing.sm },
  item: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: spacing.md,
    gap: spacing.xs,
  },
  itemKey: { ...typography.mono, color: colors.text, fontWeight: "600" },
  itemHint: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
});
