import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";

import { CodeField } from "@/components/code-field";
import { BodyText, Button, Card, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { useJoinEvent } from "@/hooks/use-join";
import { readCodeInput, JOIN_CODE_LENGTH } from "@/lib/join";
import { rememberPendingInvite } from "@/lib/pending-invite";
import { useSession } from "@/providers/session";
import { spacing } from "@/theme";

/**
 * Join by typing the six-digit code.
 *
 * The fallback for every guest whose camera will not read the QR — bad light, cracked
 * lens, a printed sign behind a bar. It is the *second* path, not the first: a code is
 * only a million values, so every attempt here spends a slot from the throttle budget
 * in `@partybooth/contracts/join` (ten failures per fifteen minutes, then a lockout).
 *
 * There is deliberately **no preview step**. `join.previewByCode` exists and is a
 * mutation precisely because answering "is this a real code?" has to cost the same
 * budget as joining does — so previewing and then joining would spend two slots to
 * learn one thing. Typing the code and being let in is one slot and one screen.
 */
export default function JoinByCodeRoute() {
  const router = useRouter();
  const { state, configured } = useSession();
  const { phase, busy, attempt, reset } = useJoinEvent();
  // The **sanitised** digits, not the raw keystroke. A controlled `TextInput` whose
  // `value` prop does not change after `onChangeText` can leave the rejected character
  // visible in the native view, so the field state and what the field renders have to
  // be the same string. `readCodeInput` is idempotent, which is what makes that safe.
  const [digits, setDigits] = useState("");

  const field = readCodeInput(digits);
  const signedIn = state.status === "signed-in";
  /** Only a throttle carries a wait; a plain rejection is retryable straight away. */
  const throttled = phase.status === "refused" && phase.copy.retryAfterMs !== undefined;

  const submit = useCallback(async () => {
    if (!field.complete || busy) return;
    await attempt({ via: "code", code: field.digits });
  }, [attempt, busy, field.complete, field.digits]);

  // Landing on the party is the whole point, so the screen closes itself rather than
  // asking for one more tap. The header and the Camera tab are already subscribed to
  // the new active event by the time this runs.
  useEffect(() => {
    if (phase.status !== "joined") return;
    const timer = setTimeout(() => router.replace("/camera"), 600);
    return () => clearTimeout(timer);
  }, [phase.status, router]);

  const onChangeText = useCallback(
    (next: string) => {
      setDigits(readCodeInput(next).digits);
      // Clearing the failure as soon as they start correcting it: leaving "that didn't
      // work" under a code they are actively retyping reads as a live verdict.
      if (phase.status === "refused" || phase.status === "error") reset();
    },
    [phase.status, reset],
  );

  return (
    <Screen edges={["left", "right", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenHeader
            title="Enter the join code"
            subtitle={`The ${JOIN_CODE_LENGTH} digits printed under the QR code on the host's sign.`}
          />

          <CodeField
            value={field.digits}
            onChangeText={onChangeText}
            onSubmit={() => void submit()}
            editable={signedIn && !busy && phase.status !== "joined"}
            autoFocus={signedIn}
            invalid={phase.status === "refused"}
          />

          {field.error ? (
            <Notice tone="warning" title="Check the code">
              <MutedText>{field.error}</MutedText>
            </Notice>
          ) : null}

          {phase.status === "refused" ? (
            <Notice tone="danger" title={phase.copy.title}>
              <BodyText>{phase.copy.message}</BodyText>
              <MutedText>{phase.copy.hint}</MutedText>
            </Notice>
          ) : null}

          {phase.status === "error" ? (
            <Notice tone="danger" title={phase.copy.title}>
              <MutedText>{phase.copy.message}</MutedText>
            </Notice>
          ) : null}

          {phase.status === "joined" ? (
            <Notice tone="success" title={phase.alreadyMember ? "You're already in" : "You're in"}>
              <MutedText>Taking you to the party…</MutedText>
            </Notice>
          ) : null}

          {!signedIn ? (
            <Card>
              <BodyText>Sign in first — a party knows who sent every photo.</BodyText>
              <Button
                label="Sign in to join"
                icon="log-in-outline"
                // A code already typed is worth keeping across the sign-in detour —
                // and it is one fewer attempt against the throttle budget.
                onPress={() => {
                  if (field.complete) {
                    rememberPendingInvite({ kind: "code", code: field.digits });
                  }
                  router.replace("/sign-in");
                }}
                disabled={!configured}
              />
            </Card>
          ) : (
            <Button
              label="Join the party"
              icon="arrow-forward"
              onPress={() => void submit()}
              // Throttled means the next attempt is refused before it is read, so the
              // button stays down rather than spending a slot to say so again.
              disabled={!field.complete || phase.status === "joined" || throttled}
              busy={busy}
            />
          )}

          <MutedText>
            Scanning the QR code is quicker and never gets throttled. Codes change when the host
            rotates the invite, so an old photo of a sign will not work.
          </MutedText>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
});
