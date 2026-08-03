/**
 * Settings — the main page of the stack.
 *
 * A short list of rows, iOS-style; anything with real weight lives on a
 * subpage. The three things App Review will look for stay one tap from here:
 * Apple 5.1.1(v) account deletion (Account Data), Guideline 1.2 blocked-user
 * management (Blocked People), and the 5.1.1(i) privacy policy (opened
 * directly). All three are checked by a human with a list.
 */

import { TERMS_PATH } from "@partybooth/contracts/terms";
import Constants from "expo-constants";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { Ionicons } from "@expo/vector-icons";

import { ListRow, ListSection } from "@/components/settings-list";
import { Button, MonoText, MutedText, Notice, Screen } from "@/components/ui";
import { appConfig } from "@/env";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/**
 * Where the privacy policy lives.
 *
 * Derived from the configured site rather than hardcoded, because the same build
 * runs against a preview deployment and against production and the link has to
 * be right in both.
 *
 * The route itself is `apps/web`'s (`src/app/privacy/page.tsx`) and is public by
 * design — App Review requires a privacy URL that works without an account, and
 * rejects a dead one. **Check it resolves on the deployed site before
 * submitting**, because the two halves live in different apps and nothing here
 * can notice a 404: `docs/store/ios-submission.md` §3.1.
 */
const PRIVACY_PATH = "/privacy";

/**
 * Where the user terms live.
 *
 * Same argument as the privacy path above, plus one of its own: Play's UGC
 * policy asks for terms that define and prohibit objectionable content, that a
 * user can reach, and that the user has accepted. Onboarding takes the
 * acceptance; this is the reachable half, and it is deliberately in the same
 * group so somebody looking for "the legal stuff" finds both.
 */
const TERMS_PATH_IN_APP = TERMS_PATH;

export default function SettingsScreen() {
  const router = useRouter();
  const { state, configured, signOut, previewEventRole, setPreviewEventRole, activeEvent, events } =
    useSession();
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
  const legalReady = appConfig.status === "ready";

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        {user ? (
          <ProfileRow
            name={user.name ?? "Guest"}
            email={user.email}
            image={user.image}
            onPress={() => router.push("/onboarding")}
          />
        ) : (
          <View style={styles.signedOut}>
            <MutedText>Sign in to send photos to an event.</MutedText>
            <Button
              label="Sign in"
              icon="log-in-outline"
              onPress={() => router.push("/sign-in")}
              disabled={!configured}
            />
          </View>
        )}

        {user ? (
          <ListSection
            header="Party"
            footer={
              events.length > 0
                ? `You have joined ${String(events.length)} ${events.length === 1 ? "party" : "parties"}. Switch, leave, or join another one.`
                : "Join a party to start sending photos to it."
            }
          >
            <ListRow
              label="Party"
              value={activeEvent?.name ?? "None yet"}
              onPress={() => router.push("/settings/parties")}
              disabled={!configured}
              accessibilityHint="Switch between your parties, leave one, or join another."
            />
          </ListSection>
        ) : null}

        {user && configured ? (
          <ListSection>
            <ListRow
              icon="notifications-outline"
              label="Notifications"
              onPress={() => router.push("/settings/notifications")}
            />
            <ListRow
              icon="person-remove-outline"
              label="Blocked people"
              onPress={() => router.push("/settings/blocked")}
            />
          </ListSection>
        ) : null}

        {user && configured ? (
          <ListSection header="Account">
            <ListRow
              icon="mail-outline"
              label="Verified emails"
              onPress={() => router.push("/settings/emails")}
            />
            <ListRow
              icon="folder-outline"
              label="Account data"
              onPress={() => router.push("/settings/account")}
              accessibilityHint="What PartyBooth stores, and deleting your account."
            />
          </ListSection>
        ) : null}

        {/* Reachable without signing in, because a privacy policy that is only
            visible to people who already handed over their data is not one. */}
        <ListSection
          header="Privacy & legal"
          footer="What PartyBooth stores, who can see it, and how long it is kept. Photos and videos are private to the party you sent them to."
        >
          <ListRow
            icon="shield-checkmark-outline"
            label="Privacy policy"
            chevron={false}
            onPress={() => void openLegalPage(PRIVACY_PATH, "settings.privacyPolicy")}
            disabled={!legalReady}
          />
          <ListRow
            icon="document-text-outline"
            label="Terms of use"
            chevron={false}
            onPress={() => void openLegalPage(TERMS_PATH_IN_APP, "settings.terms")}
            disabled={!legalReady}
          />
        </ListSection>

        <ListSection>
          <ListRow
            label="About"
            value={Constants.expoConfig?.version ?? "0.1.0"}
            onPress={() => router.push("/settings/about")}
          />
        </ListSection>

        {!configured ? (
          <Notice tone="warning" title="Running without a backend">
            <MutedText>
              No Convex deployment is configured, so sign-in, uploads and galleries are disabled.
              Run <MonoText>bun run env:doctor</MonoText> at the repo root to see what is missing.
            </MutedText>
          </Notice>
        ) : null}

        {/* Dev-only, and only useful when there is *no* membership to read a role
            from: the switch is ignored the moment a real active event exists, so it
            can never show a developer affordances the same build denies a guest.
            Stripped from release builds by the `__DEV__` guard. */}
        {__DEV__ && activeEvent === null ? (
          <ListSection
            header="Developer"
            footer="Fakes an owner membership so the Host tab appears while you have not joined a party. A real membership always wins over this. Dev builds only."
          >
            <ListRow
              label="Preview host tools"
              accessory={
                <Switch
                  value={previewEventRole !== null}
                  onValueChange={(next) => setPreviewEventRole(next ? "owner" : null)}
                  trackColor={{ true: colors.accent, false: colors.border }}
                  accessibilityLabel="Preview host tools"
                />
              }
            />
          </ListSection>
        ) : null}

        {user ? (
          <ListSection>
            <ListRow
              label="Sign out"
              tone="danger"
              centered
              busy={signingOut}
              onPress={() => void handleSignOut()}
            />
          </ListSection>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Avatar, name and email — tapping reuses the onboarding screen to edit both. */
function ProfileRow({
  name,
  email,
  image,
  onPress,
}: {
  name: string;
  email: string | null;
  image: string | null;
  onPress: () => void;
}) {
  const initial = (name[0] ?? "?").toUpperCase();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Edit name and photo"
      onPress={onPress}
      style={({ pressed }) => [styles.profile, pressed && styles.profilePressed]}
    >
      <View style={styles.avatar}>
        {image ? (
          <Image source={{ uri: image }} style={styles.avatarImage} contentFit="cover" />
        ) : (
          <Text style={styles.avatarInitial}>{initial}</Text>
        )}
      </View>
      <View style={styles.profileText}>
        <Text style={styles.profileName} numberOfLines={1}>
          {name}
        </Text>
        {email ? <MutedText>{email}</MutedText> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

/**
 * Open a public legal page in the system browser sheet.
 *
 * `expo-web-browser` rather than `Linking.openURL`: it presents in-app (SFSafari
 * / Custom Tabs), so a guest reading the policy does not lose the app, and it is
 * imported on demand because nothing else on this screen needs it.
 */
async function openLegalPage(path: string, scope: string): Promise<void> {
  if (appConfig.status !== "ready") return;
  try {
    const WebBrowser = await import("expo-web-browser");
    await WebBrowser.openBrowserAsync(`${appConfig.siteUrl}${path}`);
  } catch (error) {
    captureHandledError(error, { scope });
  }
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  signedOut: { gap: spacing.md, paddingVertical: spacing.sm },
  profile: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  profilePressed: { backgroundColor: colors.surfaceRaised },
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
});
