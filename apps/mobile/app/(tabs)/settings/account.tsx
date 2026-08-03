/**
 * Account data — what PartyBooth holds about this account, and in-app account
 * deletion (Apple 5.1.1(v)).
 *
 * Deletion is two taps and the second one says exactly what happens, because
 * what happens is unusual enough that "Are you sure?" would be a lie by
 * omission:
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

import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, MutedText, Notice, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { colors, spacing, typography } from "@/theme";

export default function AccountDataScreen() {
  const router = useRouter();
  const { state } = useSession();
  const user = state.status === "signed-in" ? state.user : null;

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        {user ? (
          <View style={styles.facts}>
            <Fact label="Name" value={user.name ?? "—"} />
            <Fact label="Sign-in email" value={user.email ?? "—"} />
          </View>
        ) : null}

        <MutedText>
          Your account holds your name, your sign-in email, the parties you have joined, and the
          photos and videos you sent to them. Photos and videos are private to the party you sent
          them to.
        </MutedText>

        <DeleteAccountSection onSignedOut={() => router.replace("/")} />
      </ScrollView>
    </Screen>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <MutedText>{label}</MutedText>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

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
      <View style={styles.deleteBlock}>
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
      </View>
    );
  }

  return (
    <View style={styles.deleteBlock}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  facts: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  rowValue: { ...typography.body, color: colors.text, flexShrink: 1 },
  sectionLabel: { ...typography.label, color: colors.textMuted, textTransform: "uppercase" },
  deleteBlock: { gap: spacing.md, paddingTop: spacing.lg },
  confirmActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
