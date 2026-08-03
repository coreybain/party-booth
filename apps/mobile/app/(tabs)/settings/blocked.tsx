/**
 * Blocked people — the list App Review looks for: who you have blocked, and
 * how to undo it (Guideline 1.2).
 *
 * Blocking is silent and global to your account (not per party), so this is the
 * only place the state is visible at all — there is deliberately no marker on
 * the blocked person's rows anywhere else, because their content simply is not
 * returned to you.
 */

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, MutedText, Notice, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { captureHandledError } from "@/lib/sentry";
import { colors, spacing, typography } from "@/theme";

export default function BlockedScreen() {
  const blocks = useQuery(api.blocks.myBlocks, {});
  const unblock = useMutation(api.blocks.unblock);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onUnblock = useCallback(
    async (userId: string): Promise<void> => {
      setWorking(userId);
      setError(null);
      try {
        await unblock({ userId });
      } catch (caught) {
        captureHandledError(caught, { scope: "settings.unblock" });
        setError(describeError(caught).message);
      } finally {
        setWorking(null);
      }
    },
    [unblock],
  );

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        {blocks === undefined ? (
          <MutedText>Loading…</MutedText>
        ) : blocks.length === 0 ? (
          <MutedText>
            You have not blocked anyone. Blocking someone hides everything they post, in every
            party, just for you — and they are never told.
          </MutedText>
        ) : (
          <>
            <MutedText>
              Their photos and videos are hidden from you everywhere. They are not told, and they
              stay in the party.
            </MutedText>
            {blocks.map((blocked) => (
              <View key={blocked.userId} style={styles.row}>
                <Text style={styles.rowValue}>{blocked.displayName}</Text>
                <Button
                  label="Unblock"
                  variant="secondary"
                  icon="person-add-outline"
                  busy={working === blocked.userId}
                  onPress={() => void onUnblock(blocked.userId)}
                />
              </View>
            ))}
          </>
        )}

        {error !== null ? (
          <Notice tone="danger" title="That didn't work">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  rowValue: { ...typography.body, color: colors.text },
});
