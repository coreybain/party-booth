/**
 * Verified emails — claim a reachable address when Apple supplied a
 * private-relay one.
 *
 * These addresses unlock invitations; they never become another unverified
 * sign-in credential, and the backend only matches them after the OTP succeeds.
 */

import { OTP_POLICY } from "@partybooth/contracts/otp";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { CodeField } from "@/components/code-field";
import { Badge, BodyText, Button, MutedText, Notice, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { formatOtpCooldown, readEmailInput, readOtpInput } from "@/lib/email-otp";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

export default function VerifiedEmailsScreen() {
  const { state } = useSession();
  const primaryEmail = state.status === "signed-in" ? state.user.email : null;

  const emails = useQuery(api.emails.myEmails, {});
  const requestVerification = useAction(api.emails.requestVerification);
  const confirmVerification = useMutation(api.emails.confirmVerification);

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const emailField = readEmailInput(email, emailTouched);
  const codeField = readOtpInput(code, codeTouched);
  const resendSeconds = Math.max(0, (resendAt - now) / 1_000);

  useEffect(() => {
    if (step !== "code" || resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= resendAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [resendAt, step]);

  const send = useCallback(async () => {
    setEmailTouched(true);
    const input = readEmailInput(email, true);
    if (!input.valid) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestVerification({ email: input.value });
      setEmail(input.value);
      setCode("");
      setCodeTouched(false);
      setStep("code");
      const sentAt = Date.now();
      setNow(sentAt);
      setResendAt(sentAt + OTP_POLICY.resendCooldownMs);
    } catch (caught) {
      captureHandledError(caught, { scope: "settings.requestEmailVerification" });
      const copy = describeError(caught);
      setError(copy.message);
      if (copy.retryAfterMs !== undefined) {
        const refusedAt = Date.now();
        setNow(refusedAt);
        setResendAt(refusedAt + copy.retryAfterMs);
      }
    } finally {
      setBusy(false);
    }
  }, [email, requestVerification]);

  const confirm = useCallback(async () => {
    setCodeTouched(true);
    const input = readOtpInput(code, true);
    if (!input.complete) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await confirmVerification({ email: emailField.value, code: input.digits });
      if (!result.ok) {
        setError(result.message);
        return;
      }

      const unlocked = [
        ...(result.organiserUnlocked ? ["organiser access"] : []),
        ...(result.cohostEventIds.length > 0
          ? [
              `${String(result.cohostEventIds.length)} co-host ${
                result.cohostEventIds.length === 1 ? "role" : "roles"
              }`,
            ]
          : []),
      ];
      setNotice(
        unlocked.length > 0
          ? `Email verified. This unlocked ${unlocked.join(" and ")}.`
          : "Email verified. It will match any organiser or co-host invitation sent to it.",
      );
      setEmail("");
      setCode("");
      setEmailTouched(false);
      setCodeTouched(false);
      setStep("email");
    } catch (caught) {
      captureHandledError(caught, { scope: "settings.confirmEmailVerification" });
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [code, confirmVerification, emailField.value]);

  return (
    <Screen edges={["left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <MutedText>
          Signed in with Apple Hide My Email? Add the address your organiser or co-host invitation
          was sent to. Verifying it can unlock that invitation without changing your sign-in email.
        </MutedText>

        {primaryEmail ? (
          <View style={styles.row}>
            <MutedText>Sign-in email</MutedText>
            <Text style={styles.rowValue}>{primaryEmail}</Text>
          </View>
        ) : null}

        {emails === undefined ? (
          <MutedText>Loading verified addresses…</MutedText>
        ) : emails.length === 0 ? (
          <MutedText>No extra email addresses added.</MutedText>
        ) : (
          <View style={styles.emailList}>
            {emails.map((entry) => (
              <View key={entry.email} style={styles.emailRow}>
                <Text style={styles.emailAddress}>{entry.email}</Text>
                <Badge
                  label={entry.status === "verified" ? "verified" : "pending"}
                  tone={entry.status === "verified" ? colors.success : colors.warning}
                />
              </View>
            ))}
          </View>
        )}

        {step === "email" ? (
          <>
            <Text style={styles.label}>Address to verify</Text>
            <TextInput
              value={email}
              onChangeText={(next) => {
                setEmail(next);
                setError(null);
                setNotice(null);
              }}
              onBlur={() => setEmailTouched(true)}
              placeholder="invited-address@example.com"
              placeholderTextColor={colors.textFaint}
              style={[styles.input, emailField.error ? styles.inputInvalid : null]}
              keyboardType="email-address"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => void send()}
              editable={!busy}
              accessibilityLabel="Address to verify"
            />
            {emailField.error ? <Text style={styles.fieldError}>{emailField.error}</Text> : null}
            <Button
              label="Send verification code"
              icon="mail-outline"
              onPress={() => void send()}
              disabled={!emailField.valid || busy}
              busy={busy}
            />
          </>
        ) : (
          <>
            <BodyText>Enter the code sent to {emailField.value}.</BodyText>
            <CodeField
              value={codeField.digits}
              onChangeText={(next) => {
                setCode(readOtpInput(next).digits);
                setError(null);
              }}
              onSubmit={() => void confirm()}
              editable={!busy}
              autoFocus
              invalid={Boolean(codeField.error || error)}
              length={OTP_POLICY.codeLength}
              accessibilityLabel="Six-digit verification code"
              accessibilityHint="Type the code sent to the email address you are adding."
            />
            {codeField.error ? <Text style={styles.fieldError}>{codeField.error}</Text> : null}
            <Button
              label="Verify email"
              icon="checkmark"
              onPress={() => void confirm()}
              disabled={!codeField.complete || busy}
              busy={busy}
            />
            <Button
              label={
                resendSeconds > 0
                  ? `Send another code in ${formatOtpCooldown(resendSeconds)}`
                  : "Send another code"
              }
              variant="secondary"
              icon="refresh"
              onPress={() => void send()}
              disabled={busy || resendSeconds > 0}
            />
            <Button
              label="Use a different email"
              variant="secondary"
              onPress={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
              disabled={busy}
            />
          </>
        )}

        {error ? (
          <Notice tone="danger" title="That email wasn't verified">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}
        {notice ? (
          <Notice tone="success" title="Email verified">
            <MutedText>{notice}</MutedText>
          </Notice>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  label: { ...typography.label, color: colors.textMuted, textTransform: "uppercase" },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  inputInvalid: { borderColor: colors.danger },
  fieldError: { ...typography.caption, color: colors.danger },
  emailList: { gap: spacing.sm },
  emailRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  emailAddress: { ...typography.body, color: colors.text, flex: 1 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  rowValue: { ...typography.body, color: colors.text, flexShrink: 1 },
});
