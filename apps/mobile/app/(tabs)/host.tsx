import { ScrollView, StyleSheet } from "react-native";

import { Badge, EmptyState, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { canAccessHostTools } from "@/lib/roles";
import { useRoles } from "@/providers/session";
import { spacing } from "@/theme";

/**
 * Host tab — scaffold. Built out in Sprint 5 (QR/code, rotation, pending queue, quick
 * approve/decline).
 *
 * The role check is repeated here even though `(tabs)/_layout.tsx` already hides the tab
 * button. `href: null` only removes the button; the route stays navigable by deep link
 * and by `router.push`, so the screen must defend itself. Treating navigation as the
 * only gate is how host tools leak to guests.
 */
export default function HostScreen() {
  const roles = useRoles();

  if (!canAccessHostTools(roles)) {
    return (
      <Screen>
        <ScreenHeader title="Host" />
        <EmptyState
          icon="lock-closed-outline"
          title="Host tools aren't available"
          body="Only the event owner and co-hosts can moderate. If you should have access, ask the host to add you as a co-host."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Host" subtitle="Moderate the queue and manage the invite." />

        <Notice tone="info" title="Scaffold">
          <Badge label="sprint 5" />
          <MutedText>
            The pending queue, quick approve/decline, the six-digit code and QR, and invite rotation
            all mount here. Moderation itself lands in Sprint 4 on the web console first, then this
            tab.
          </MutedText>
        </Notice>

        <EmptyState
          icon="hourglass-outline"
          title="Nothing waiting"
          body="Submissions needing a decision will queue up here, newest first, with the submitter's name and a one-tap approve or decline."
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
});
