import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Badge, Card, EmptyState, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { useNow } from "@/hooks/use-now";
import { describeEventState, describeSchedule } from "@/lib/events";
import { canAccessHostTools, canModerateMedia, canRotateInvite } from "@/lib/roles";
import { useSession } from "@/providers/session";
import { colors, spacing, typography } from "@/theme";

/**
 * Host tab.
 *
 * Sprint 2's job here is that the tab **exists for the right people**: the owner, a
 * co-host added by hand, and — the case worth naming — an account that matched a
 * pending co-host invitation by verified email. That last one needs no action from
 * anybody: `users.refreshRoles` re-runs matching on launch, the membership row is
 * upgraded to `cohost` server-side, and `events.activeEvent` reports the new role, so
 * the tab appears. See `src/providers/session.tsx`.
 *
 * The contents — QR/code, rotation, pending queue, quick approve/decline — are Sprint
 * 5. What is shown below is the part that is true today: which party these tools would
 * act on, and which of them this role is allowed to use.
 *
 * The role check is repeated here even though `(tabs)/_layout.tsx` already hides the
 * tab button. `href: null` only removes the button; the route stays navigable by deep
 * link and by `router.push`, so the screen must defend itself. Treating navigation as
 * the only gate is how host tools leak to guests.
 */
export default function HostScreen() {
  const { roles, activeEvent } = useSession();
  const now = useNow();

  if (!canAccessHostTools(roles)) {
    return (
      <Screen edges={["left", "right"]}>
        <ScreenHeader title="Host" />
        <EmptyState
          icon="lock-closed-outline"
          title="Host tools aren't available"
          body="Only the event owner and co-hosts can moderate. If you should have access, ask the host to add you as a co-host — you are matched on the email address you signed in with."
        />
      </Screen>
    );
  }

  const description = activeEvent ? describeEventState(activeEvent.state) : null;

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Host"
          subtitle={activeEvent ? activeEvent.name : "Moderate the queue and manage the invite."}
        />

        {activeEvent ? (
          <Card>
            <View style={styles.badges}>
              <Badge label={roles.eventRole === "owner" ? "owner" : "co-host"} />
              {description ? (
                <Badge
                  label={description.label}
                  tone={description.tone === "live" ? colors.success : colors.textFaint}
                />
              ) : null}
            </View>
            <Text style={styles.when}>{describeSchedule(activeEvent, now)}</Text>
            <MutedText>
              {`${activeEvent.counts.pending} waiting · ${activeEvent.counts.approved} approved · ${activeEvent.counts.total} in total`}
            </MutedText>
            <MutedText>
              {canModerateMedia(roles)
                ? "You can approve and decline submissions here."
                : "Your account is locked, so moderation is suspended."}
              {canRotateInvite(roles) ? " You can also rotate the code and QR." : ""}
            </MutedText>
          </Card>
        ) : (
          <EmptyState
            icon="qr-code-outline"
            title="No party selected"
            body="Pick a party from the switcher at the top to see its queue."
          />
        )}

        <Notice tone="info" title="Scaffold">
          <Badge label="sprint 5" />
          <MutedText>
            The pending queue, quick approve/decline, the six-digit code and QR, and invite rotation
            all mount here. Moderation itself lands in Sprint 4 on the web console first, then this
            tab.
          </MutedText>
        </Notice>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  badges: { flexDirection: "row", gap: spacing.sm },
  when: { ...typography.heading, color: colors.text },
});
