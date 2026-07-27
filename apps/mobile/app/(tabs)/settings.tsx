import { Image } from "expo-image";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import {
  Badge,
  BodyText,
  Button,
  Card,
  MonoText,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { appConfig } from "@/env";
import { isSentryEnabled } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const { state, configured, signOut, previewEventRole, setPreviewEventRole } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace("/");
    } finally {
      setSigningOut(false);
    }
  }, [signOut, router]);

  const user = state.status === "signed-in" ? state.user : null;
  const displayName = user?.name ?? "Not signed in";
  const initial = (user?.name?.[0] ?? "?").toUpperCase();

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Settings" />

        {/* Profile stub — editing name/photo reuses the onboarding screen in Sprint 2. */}
        <Card>
          <View style={styles.profile}>
            <View style={styles.avatar}>
              {user?.image ? (
                <Image source={{ uri: user.image }} style={styles.avatarImage} contentFit="cover" />
              ) : (
                <Text style={styles.avatarInitial}>{initial}</Text>
              )}
            </View>
            <View style={styles.profileText}>
              <Text style={styles.profileName}>{displayName}</Text>
              <MutedText>{user?.email ?? "Sign in to send photos to an event."}</MutedText>
            </View>
          </View>

          {user ? (
            <Button
              label="Edit name and photo"
              variant="secondary"
              icon="create-outline"
              onPress={() => router.push("/onboarding")}
            />
          ) : (
            <Button
              label="Sign in"
              icon="log-in-outline"
              onPress={() => router.push("/sign-in")}
              disabled={!configured}
            />
          )}
        </Card>

        {!configured ? (
          <Notice tone="warning" title="Running without a backend">
            <MutedText>
              No Convex deployment is configured, so sign-in, uploads and galleries are disabled.
              Run <MonoText>pnpm env:doctor</MonoText> at the repo root to see what is missing.
            </MutedText>
          </Notice>
        ) : null}

        {/* Dev-only: lets the conditional Host tab be exercised before memberships
            exist (Sprint 2). Stripped from release builds by the `__DEV__` guard. */}
        {__DEV__ ? (
          <Card>
            <Badge label="dev only" tone={colors.accentSoft} />
            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <BodyText>Preview host tools</BodyText>
                <MutedText>
                  Fakes an <MonoText>owner</MonoText> membership so the Host tab appears. Real roles
                  arrive with memberships in Sprint 2.
                </MutedText>
              </View>
              <Switch
                value={previewEventRole !== null}
                onValueChange={(next) => setPreviewEventRole(next ? "owner" : null)}
                trackColor={{ true: colors.accent, false: colors.border }}
                accessibilityLabel="Preview host tools"
              />
            </View>
          </Card>
        ) : null}

        <Card>
          <Text style={styles.sectionLabel}>About</Text>
          <Row label="Version" value={`${Constants.expoConfig?.version ?? "0.1.0"}`} />
          <Row label="Backend" value={configured ? "connected" : "not configured"} />
          <Row label="Error reporting" value={isSentryEnabled() ? "on" : "off (no DSN)"} />
          <Row
            label="Push notifications"
            value={
              appConfig.status === "ready" && appConfig.features.push
                ? "available"
                : "off (no EAS project id)"
            }
          />
        </Card>

        <Notice tone="info" title="Required before App Review">
          <Badge label="sprint 4" />
          <MutedText>
            Report content, block a user, and in-app account deletion are mandatory for submission
            and are built in Sprint 4, alongside the privacy policy link and the reviewer demo
            login.
          </MutedText>
        </Notice>

        {user ? (
          <Button
            label="Sign out"
            variant="danger"
            icon="log-out-outline"
            onPress={() => void handleSignOut()}
            busy={signingOut}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <MutedText>{label}</MutedText>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  profile: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarInitial: { ...typography.title, color: colors.accent },
  profileText: { flex: 1, gap: spacing.xs },
  profileName: { ...typography.heading, color: colors.text },
  sectionLabel: { ...typography.label, color: colors.textMuted, textTransform: "uppercase" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  rowValue: { ...typography.body, color: colors.text },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  switchCopy: { flex: 1, gap: spacing.xs },
});
