import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";

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
import { captureHandledError } from "@/lib/sentry";
import { useAuthClient } from "@/providers";
import { useSession } from "@/providers/session";
import { spacing } from "@/theme";

/** Where the OAuth round-trip returns to. `expoClient` rewrites this into `partybooth://`. */
const CALLBACK_PATH = "/";

export default function SignInScreen() {
  const authClient = useAuthClient();
  const { state } = useSession();
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              disabled={!configured || busy}
              busy={pending === "apple"}
            />
          ) : null}

          <Button
            label="Continue with Google"
            icon="logo-google"
            variant={Platform.OS === "android" ? "primary" : "secondary"}
            onPress={() => void run("google")}
            disabled={!configured || busy}
            busy={pending === "google"}
          />
        </View>

        <Card>
          <BodyText>
            Guests on the web sign in with Google or a six-digit email code instead.
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
});
