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

import {
  HOST_ONLY_PUSH_CATEGORIES,
  PUSH_CATEGORY_COPY,
  type PushCategory,
} from "@partybooth/contracts/push";
import { TERMS_PATH } from "@partybooth/contracts/terms";
import { useMutation, useQuery } from "convex/react";
import Constants from "expo-constants";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

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
import { usePush } from "@/push/provider";
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
 * card so somebody looking for "the legal stuff" finds both.
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
            onPress={() => void openLegalPage(PRIVACY_PATH, "settings.privacyPolicy")}
            disabled={appConfig.status !== "ready"}
          />
          <Button
            label="Terms of use"
            variant="secondary"
            icon="document-text-outline"
            onPress={() => void openLegalPage(TERMS_PATH_IN_APP, "settings.terms")}
            disabled={appConfig.status !== "ready"}
          />
        </Card>

        {user && configured ? <NotificationsSection /> : null}

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

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-category toggles and the host threshold.
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
      <Card>
        <Text style={styles.sectionLabel}>Notifications</Text>
        <MutedText>
          This build has no Expo project configured, so it cannot receive notifications. Nothing is
          lost — the app still tells you about uploads and the queue while it is open.
        </MutedText>
      </Card>
    );
  }

  const optOut = preferences?.optOut ?? [];
  const categories = (preferences?.categories ?? []).filter(
    (category) => hosts || !(HOST_ONLY_PUSH_CATEGORIES as readonly string[]).includes(category),
  );

  return (
    <Card>
      <Text style={styles.sectionLabel}>Notifications</Text>

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
    </Card>
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
 * Imported on demand for the same reason the legal pages are: nothing else on
 * this screen needs it.
 */
async function openSystemSettings(): Promise<void> {
  try {
    const { Linking } = await import("react-native");
    await Linking.openSettings();
  } catch (error) {
    captureHandledError(error, { scope: "settings.openSystemSettings" });
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
 * - **Everything is erased after thirty days**, and until then the deletion can
 *   be undone by asking. The worker is `convex/deletion.ts`, run daily by
 *   `convex/crons.ts`: media and stored objects, memberships, blocks, push
 *   devices and the Better Auth credential — the Apple grant included. It ships
 *   *with* the button, because a delete button whose worker is post-launch is
 *   indefinite deactivation with a deletion label on it, which is neither what
 *   Apple's guideline asks for nor what the copy said.
 * - **Photographs are anonymised at once and erased with the rest.** For the
 *   thirty days a restore is still possible the attribution goes
 *   (`uploaderNameFor` returns "Former guest") and the picture stays, so a host
 *   mid-party does not lose the evening; after that both go. Retention was a
 *   defensible answer for the restore window and was never a defensible answer
 *   to "delete my data". This is the part a guest is most likely to be surprised
 *   by, so it is said before the button, not after.
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
          Closes your PartyBooth account and signs you out of every device. Everything you sent is
          erased 30 days later. You can ask us to restore it before then; after that it is gone for
          good.
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
          After 30 days everything goes: your photos and videos, the files behind them, the parties
          you joined, your blocks, and your sign-in with Apple or Google. Until then, email us and
          we can put it back.
        </MutedText>
        <MutedText>
          For those 30 days your photos stay with the party but your name comes off them, so a host
          mid-event does not lose the night. If you want something gone now, take it back from “My
          media” — that deletes it immediately, for everyone.
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
