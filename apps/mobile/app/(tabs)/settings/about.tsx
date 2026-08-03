/** About — build facts that used to crowd the main settings page. */

import Constants from "expo-constants";
import { ScrollView, StyleSheet } from "react-native";

import { ListRow, ListSection } from "@/components/settings-list";
import { Screen } from "@/components/ui";
import { appConfig } from "@/env";
import { isSentryEnabled } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { spacing } from "@/theme";

export default function AboutScreen() {
  const { configured } = useSession();

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <ListSection>
          <ListRow label="Version" value={Constants.expoConfig?.version ?? "0.1.0"} />
          <ListRow label="Backend" value={configured ? "connected" : "not configured"} />
          <ListRow label="Error reporting" value={isSentryEnabled() ? "on" : "off (no DSN)"} />
          <ListRow
            label="Push notifications"
            value={
              appConfig.status === "ready" && appConfig.features.push
                ? "available"
                : "off (no EAS project id)"
            }
          />
        </ListSection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
});
