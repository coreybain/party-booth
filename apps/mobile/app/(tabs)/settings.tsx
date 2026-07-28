/**
 * Settings — profile, parties, and the three things App Review will look for.
 *
 * `AccountSection`, `BlockedSection` and the privacy-policy link below are not
 * conveniences. Apple 5.1.1(v) requires an app that supports account creation to
 * offer **account deletion from inside the app**, Guideline 1.2 requires a
 * visible way to manage blocked users, and 5.1.1(i) requires the privacy policy
 * to be reachable. All three are checked by a human with a list, so all three
 * are one tap from this screen rather than behind a web view.
 */

import { useMutation, useQuery } from "convex/react";
import Constants from "expo-constants";
import { Image } from "expo-image";
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
import { api } from "@/lib/api";
import { appConfig } from "@/env";
import { describeError } from "@/lib/errors";
import { captureHandledError, isSentryEnabled } from "@/lib/sentry";
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
  const displayName = user?.name ?? "Not signed in";
  const initial = (user?.name?.[0] ?? "?").toUpperCase();

  return (
    // The tab shell renders the header and owns the notch; see `(tabs)/_layout.tsx`.
    <Screen edges={["left", "right"]}>
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

        {/* The header switcher is the primary route to this; Settings is where people
            look when the header is not where they expect it. */}
        {user ? (
          <Card>
            <Text style={styles.sectionLabel}>Parties</Text>
            <Row label="Active" value={activeEvent?.name ?? "None yet"} />
            <Row label="Joined" value={`${events.length}`} />
            <Button
              label={events.length === 0 ? "Join a party" : "Switch party"}
              variant="secondary"
              icon="swap-horizontal-outline"
              onPress={() => router.push("/events")}
              disabled={!configured}
            />
          </Card>
        ) : null}

        {!configured ? (
          <Notice tone="warning" title="Running without a backend">
            <MutedText>
              No Convex deployment is configured, so sign-in, uploads and galleries are disabled.
              Run <MonoText>pnpm env:doctor</MonoText> at the repo root to see what is missing.
            </MutedText>
          </Notice>
        ) : null}

        {/* Dev-only, and now only useful when there is *no* membership to read a role
            from: the switch is ignored the moment a real active event exists, so it
            can never show a developer affordances the same build denies a guest.
            Stripped from release builds by the `__DEV__` guard. */}
        {__DEV__ && activeEvent === null ? (
          <Card>
            <Badge label="dev only" tone={colors.accentSoft} />
            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <BodyText>Preview host tools</BodyText>
                <MutedText>
                  Fakes an <MonoText>owner</MonoText> membership so the Host tab appears while you
                  have not joined a party. A real membership always wins over this.
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

        {/* Reachable without signing in, because a privacy policy that is only
            visible to people who already handed over their data is not one. */}
        <Card>
          <Text style={styles.sectionLabel}>Privacy &amp; legal</Text>
          <MutedText>
            What PartyBooth stores, who can see it, and how long it is kept. Photos and videos are
            private to the party you sent them to.
          </MutedText>
          <Button
            label="Privacy policy"
            variant="secondary"
            icon="shield-checkmark-outline"
            onPress={() => void openPrivacyPolicy()}
            disabled={appConfig.status !== "ready"}
          />
        </Card>

        {user && configured ? <BlockedSection /> : null}

        {user ? (
          <>
            <Button
              label="Sign out"
              variant="danger"
              icon="log-out-outline"
              onPress={() => void handleSignOut()}
              busy={signingOut}
            />
            {configured ? <DeleteAccountSection onSignedOut={() => router.replace("/")} /> : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * Open the policy in the system browser sheet.
 *
 * `expo-web-browser` rather than `Linking.openURL`: it presents in-app (SFSafari
 * / Custom Tabs), so a guest reading the policy does not lose the app, and it is
 * imported on demand because nothing else on this screen needs it.
 */
async function openPrivacyPolicy(): Promise<void> {
  if (appConfig.status !== "ready") return;
  try {
    const WebBrowser = await import("expo-web-browser");
    await WebBrowser.openBrowserAsync(`${appConfig.siteUrl}${PRIVACY_PATH}`);
  } catch (error) {
    captureHandledError(error, { scope: "settings.privacyPolicy" });
  }
}

/* -------------------------------------------------------------------------- */
/* Blocked people                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The list App Review looks for: who you have blocked, and how to undo it.
 *
 * Blocking is silent and global to your account (not per party), so this is the
 * only place the state is visible at all — there is deliberately no marker on
 * the blocked person's rows anywhere else, because their content simply is not
 * returned to you.
 *
 * Hidden entirely when the list is empty, apart from one line saying so. A
 * permanently empty "Blocked (0)" card is clutter in a settings screen a guest
 * opens to sign out.
 */
function BlockedSection() {
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
    <Card>
      <Text style={styles.sectionLabel}>Blocked people</Text>

      {blocks === undefined ? (
        <MutedText>Loading…</MutedText>
      ) : blocks.length === 0 ? (
        <MutedText>
          You have not blocked anyone. Blocking someone hides everything they post, in every party,
          just for you — and they are never told.
        </MutedText>
      ) : (
        <>
          <MutedText>
            Their photos and videos are hidden from you everywhere. They are not told, and they stay
            in the party.
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
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Account deletion                                                           */
/* -------------------------------------------------------------------------- */

/**
 * In-app account deletion — Apple 5.1.1(v).
 *
 * Two taps and the second one says exactly what happens, because what happens is
 * unusual enough that "Are you sure?" would be a lie by omission:
 *
 * - **Access is revoked immediately.** The account moves to `deletionScheduled`
 *   and this device signs out. There is no grace period on *access*.
 * - **The data is purged after thirty days**, and until then the deletion can be
 *   undone by asking. PLAN.md's lifecycle states ship at launch; the purge job
 *   itself is post-launch (P1), which is why the copy says "after 30 days" and
 *   not "in 30 days exactly".
 * - **Photographs are kept and anonymised, not deleted.** They belong to the
 *   party as much as to the person who took them — a guest deleting their
 *   account should not silently delete other people's memories of the night. The
 *   attribution goes (`uploaderNameFor` returns "Former guest" on the read path)
 *   and the picture stays. This is the part a guest is most likely to be
 *   surprised by, so it is said before the button, not after.
 *
 * Withdrawing individual items is a separate, genuinely destructive control in
 * "My media", and the copy points at it — somebody who wants their photographs
 * gone wants that, not this.
 */
function DeleteAccountSection({ onSignedOut }: { onSignedOut: () => void }) {
  const { signOut } = useSession();
  const requestDeletion = useMutation(api.users.requestAccountDeletion);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await requestDeletion({});
        // Sign out *after* the mutation succeeds. The other order would leave a
        // guest signed out with no idea whether the deletion was recorded, and
        // no session left to retry it with.
        await signOut();
        onSignedOut();
      } catch (caught) {
        captureHandledError(caught, { scope: "settings.deleteAccount" });
        setError(describeError(caught).message);
        setBusy(false);
      }
    })();
  }, [requestDeletion, signOut, onSignedOut]);

  if (!confirming) {
    return (
      <Card>
        <Text style={styles.sectionLabel}>Delete account</Text>
        <MutedText>
          Closes your PartyBooth account and signs you out of every device. You can ask us to
          restore it within 30 days; after that it is gone for good.
        </MutedText>
        <Button
          label="Delete my account"
          variant="danger"
          icon="trash-outline"
          accessibilityHint="Asks you to confirm first."
          onPress={() => setConfirming(true)}
        />
      </Card>
    );
  }

  return (
    <Card>
      <Text style={styles.sectionLabel}>Delete account</Text>
      <Notice tone="danger" title="Delete your PartyBooth account?">
        <MutedText>
          You will be signed out straight away and will lose access to every party you have joined.
        </MutedText>
        <MutedText>
          Your account is fully deleted after 30 days. Until then, email us and we can put it back.
        </MutedText>
        <MutedText>
          Photos and videos you sent to a party stay with that party, but your name comes off them.
          If you want something removed, take it back from “My media” first — that deletes it for
          good, for everyone.
        </MutedText>
      </Notice>

      {error !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}

      <View style={styles.confirmActions}>
        <Button label="Yes, delete my account" variant="danger" busy={busy} onPress={onDelete} />
        <Button
          label="Keep my account"
          variant="secondary"
          disabled={busy}
          onPress={() => setConfirming(false)}
        />
      </View>
    </Card>
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
  confirmActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
