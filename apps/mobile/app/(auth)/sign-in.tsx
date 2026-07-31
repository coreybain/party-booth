import { OTP_POLICY } from "@partybooth/contracts/otp";
import { Redirect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { CodeField } from "@/components/code-field";
import {
  BodyText,
  Button,
  Card,
  MonoText,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { signInWithApple, signInWithGoogle, type SocialProvider } from "@/lib/auth-client";
import {
  formatOtpCooldown,
  readEmailInput,
  readOtpInput,
  sendEmailSignInCode,
  signInWithEmailCode,
} from "@/lib/email-otp";
import { captureHandledError } from "@/lib/sentry";
import { useAuthClient } from "@/providers";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/** Where the OAuth round-trip returns to. `expoClient` rewrites this into `partybooth://`. */
const CALLBACK_PATH = "/";

export default function SignInScreen() {
  const router = useRouter();
  const authClient = useAuthClient();
  const { state } = useSession();
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailStep, setEmailStep] = useState<"closed" | "email" | "code">("closed");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const emailField = readEmailInput(email, emailTouched);
  const codeField = readOtpInput(code, codeTouched);
  const resendSeconds = Math.max(0, (resendAt - now) / 1000);

  useEffect(() => {
    if (emailStep !== "code" || resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= resendAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [emailStep, resendAt]);

  const run = useCallback(
    async (provider: SocialProvider) => {
      if (!authClient) return;
      setPending(provider);
      setError(null);
      try {
        const outcome =
          provider === "apple"
            ? await signInWithApple(authClient, CALLBACK_PATH)
            : await signInWithGoogle(authClient, CALLBACK_PATH);

        // A cancelled sheet is a normal outcome, not an error worth showing.
        if (outcome.status === "error") {
          setError(outcome.message);
          captureHandledError(new Error(outcome.message), { provider });
        }
      } finally {
        setPending(null);
      }
    },
    [authClient],
  );

  const requestCode = useCallback(async () => {
    if (!authClient) return;
    setEmailTouched(true);
    const input = readEmailInput(email, true);
    if (!input.valid) return;

    setEmailBusy(true);
    setError(null);
    const outcome = await sendEmailSignInCode(authClient, input.value);
    setEmailBusy(false);
    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }

    setEmail(input.value);
    setCode("");
    setCodeTouched(false);
    setEmailStep("code");
    const sentAt = Date.now();
    setNow(sentAt);
    setResendAt(sentAt + OTP_POLICY.resendCooldownMs);
  }, [authClient, email]);

  const verifyCode = useCallback(async () => {
    if (!authClient) return;
    setCodeTouched(true);
    const input = readOtpInput(code, true);
    if (!input.complete) return;

    setEmailBusy(true);
    setError(null);
    const outcome = await signInWithEmailCode(authClient, emailField.value, input.digits);
    setEmailBusy(false);
    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }
    // The session subscription will catch up on the entry route; going through
    // `/` also resumes an invite parked before sign-in.
    router.replace("/");
  }, [authClient, code, emailField.value, router]);

  if (state.status === "signed-in") return <Redirect href="/" />;

  const configured = authClient !== null;
  const busy = pending !== null;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          title="Join the party"
          subtitle="Sign in so your photos and videos are yours — you can withdraw anything you send."
        />

        {!configured ? (
          <Notice tone="warning" title="Sign-in isn't configured yet">
            <MutedText>
              This build has no Convex deployment, so there is nowhere to authenticate against. Set{" "}
              <MonoText>EXPO_PUBLIC_CONVEX_URL</MonoText> in{" "}
              <MonoText>apps/mobile/.env.local</MonoText> and restart the dev server. The buttons
              below stay disabled until then.
            </MutedText>
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="danger" title="Sign-in failed">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        <View style={styles.actions}>
          {/* Sign in with Apple must be offered alongside Google or App Review rejects
              the build (PLAN.md → "App Review requirements"). iOS gets the native sheet. */}
          {Platform.OS !== "android" ? (
            <Button
              label="Continue with Apple"
              icon="logo-apple"
              onPress={() => void run("apple")}
              disabled={!configured || busy || emailBusy}
              busy={pending === "apple"}
            />
          ) : null}

          <Button
            label="Continue with Google"
            icon="logo-google"
            variant={Platform.OS === "android" ? "primary" : "secondary"}
            onPress={() => void run("google")}
            disabled={!configured || busy || emailBusy}
            busy={pending === "google"}
          />

          {emailStep === "closed" ? (
            <Button
              label="Continue with email"
              icon="mail-outline"
              variant="secondary"
              onPress={() => {
                setError(null);
                setEmailStep("email");
              }}
              disabled={!configured || busy || emailBusy}
            />
          ) : null}
        </View>

        {emailStep === "email" ? (
          <Card>
            <BodyText>We&apos;ll email you a six-digit sign-in code.</BodyText>
            <Text style={styles.label}>Email address</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              onBlur={() => setEmailTouched(true)}
              placeholder="you@example.com"
              placeholderTextColor={colors.textFaint}
              style={[styles.input, emailField.error ? styles.inputInvalid : null]}
              keyboardType="email-address"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => void requestCode()}
              editable={!emailBusy}
              accessibilityLabel="Email address"
            />
            {emailField.error ? <Text style={styles.fieldError}>{emailField.error}</Text> : null}
            <Button
              label="Email me a code"
              icon="arrow-forward"
              onPress={() => void requestCode()}
              disabled={!emailField.valid || emailBusy}
              busy={emailBusy}
            />
            <Button
              label="Back to sign-in options"
              variant="secondary"
              onPress={() => {
                setEmailStep("closed");
                setError(null);
              }}
              disabled={emailBusy}
            />
          </Card>
        ) : null}

        {emailStep === "code" ? (
          <Card>
            <BodyText>Enter the code sent to {emailField.value}.</BodyText>
            <CodeField
              value={codeField.digits}
              onChangeText={(next) => {
                setCode(readOtpInput(next).digits);
                setError(null);
              }}
              onSubmit={() => void verifyCode()}
              editable={!emailBusy}
              autoFocus
              invalid={Boolean(codeField.error || error)}
              length={OTP_POLICY.codeLength}
              accessibilityLabel="Six-digit email code"
              accessibilityHint="Type the code PartyBooth emailed you."
            />
            {codeField.error ? <Text style={styles.fieldError}>{codeField.error}</Text> : null}
            <MutedText>
              The code lasts 10 minutes and stops working after {OTP_POLICY.maxAttempts} wrong
              attempts.
            </MutedText>
            <Button
              label="Verify and sign in"
              icon="checkmark"
              onPress={() => void verifyCode()}
              disabled={!codeField.complete || emailBusy}
              busy={emailBusy}
            />
            <Button
              label={
                resendSeconds > 0
                  ? `Send another code in ${formatOtpCooldown(resendSeconds)}`
                  : "Send another code"
              }
              variant="secondary"
              icon="refresh"
              onPress={() => void requestCode()}
              disabled={emailBusy || resendSeconds > 0}
            />
            <Button
              label="Use a different email"
              variant="secondary"
              onPress={() => {
                setEmailStep("email");
                setCode("");
                setError(null);
              }}
              disabled={emailBusy}
            />
          </Card>
        ) : null}

        <Card>
          <BodyText>
            Email codes use the same sign-in path on the app and the web. There is no mobile-only
            bypass.
          </BodyText>
          <MutedText>
            PartyBooth is invitation-only and 18+. Your media is private to the event you joined and
            is never made public.
          </MutedText>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  actions: { gap: spacing.md },
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
});
