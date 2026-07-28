import { TERMS_ACCEPTANCE_PROMPT, TERMS_PATH } from "@partybooth/contracts/terms";
import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Button, Card, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { appConfig } from "@/env";
import { captureHandledError } from "@/lib/sentry";
import { DISPLAY_NAME_MAX_LENGTH, initialFor, readDisplayName } from "@/lib/profile";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/**
 * Name + photo confirmation (PLAN.md → "Guests in app: Apple or Google sign-in, then
 * name + photo confirmation").
 *
 * The name is saved for real: `confirmProfile` calls Better Auth's `updateUser`, whose
 * `user.onUpdate` trigger in `packages/backend/convex/auth.ts` mirrors it into
 * `users.displayName` — the column the host's moderation queue, every membership list
 * and every audit row read. A guest who confirms "Sam" here is "Sam" to the host.
 *
 * The **photo** is remembered on the device only. Avatars ride the same short-lived
 * upload-grant pipeline as party media, which Sprint 3 builds; a `file://` path stored
 * on the server is a string no other device can resolve, and a second ad-hoc upload
 * path built now is one that has to be deleted again next sprint. So the choice is
 * kept (`src/lib/local-profile.ts`) and uploaded when there is somewhere to put it.
 */
/**
 * Open a public legal page in the system browser sheet.
 *
 * `expo-web-browser`, imported on demand, so a guest reading the terms halfway
 * through onboarding comes back to the screen they left rather than to the app's
 * cold start.
 */
async function openLegalPage(path: string): Promise<void> {
  if (appConfig.status !== "ready") return;
  try {
    const WebBrowser = await import("expo-web-browser");
    await WebBrowser.openBrowserAsync(`${appConfig.siteUrl}${path}`);
  } catch (cause) {
    captureHandledError(cause, { scope: "onboarding.legal" });
  }
}

export default function OnboardingScreen() {
  const router = useRouter();
  const { state, localProfile, confirmProfile } = useSession();

  const providerName = state.status === "signed-in" ? (state.user.name ?? "") : "";
  const providerImage = state.status === "signed-in" ? state.user.image : null;

  const [name, setName] = useState(providerName);
  const [touched, setTouched] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(localProfile.photoUri ?? providerImage);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = readDisplayName(name, touched);

  const pickPhoto = useCallback(async () => {
    try {
      // Imported lazily: the picker pulls a native module, and this screen renders on
      // every first sign-in whether or not anybody taps the avatar.
      const ImagePicker = await import("expo-image-picker");
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) setPhotoUri(result.assets[0].uri);
    } catch (cause) {
      // A denied library permission or a missing native module must not strand
      // somebody on the one screen standing between them and the party.
      captureHandledError(cause, { scope: "onboarding.pickPhoto" });
      setError("We couldn't open your photo library. You can add a photo later from Settings.");
    }
  }, []);

  const submit = useCallback(async () => {
    setTouched(true);
    const validated = readDisplayName(name, true);
    if (!validated.valid) {
      setError(validated.error);
      return;
    }

    setSaving(true);
    setError(null);
    const outcome = await confirmProfile({ displayName: validated.value, photoUri });
    setSaving(false);

    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }
    // Back through the entry gate rather than straight to a tab: `needsOnboarding`
    // has just flipped, so `/` falls through — and it is the only place that knows
    // whether an invite was parked while this guest signed in.
    router.replace("/");
  }, [confirmProfile, name, photoUri, router]);

  if (state.status === "signed-out") return <Redirect href="/sign-in" />;
  if (state.status === "loading") return <Redirect href="/" />;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          title="How should we credit you?"
          subtitle="Hosts and other guests see this name and photo next to anything you send."
        />

        <Card>
          <View style={styles.avatarRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose a profile photo"
              onPress={() => void pickPhoto()}
              style={styles.avatar}
            >
              {photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.avatarImage} contentFit="cover" />
              ) : (
                <Text style={styles.avatarInitial}>{initialFor(field.value)}</Text>
              )}
            </Pressable>
            <View style={styles.avatarCopy}>
              <Button
                label={photoUri ? "Change photo" : "Add a photo"}
                variant="secondary"
                icon="image-outline"
                onPress={() => void pickPhoto()}
                disabled={saving}
              />
              <MutedText>Optional. You can change it later from Settings.</MutedText>
            </View>
          </View>
        </Card>

        <Card>
          <Text style={styles.label}>Display name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            onBlur={() => setTouched(true)}
            placeholder="Your name"
            placeholderTextColor={colors.textFaint}
            style={[styles.input, field.error ? styles.inputInvalid : null]}
            // Same ceiling the contract enforces, so the keyboard stops rather than
            // the form rejecting a name after it has been typed.
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            editable={!saving}
            accessibilityLabel="Display name"
          />
          {field.error ? (
            <Text style={styles.fieldError}>{field.error}</Text>
          ) : (
            <MutedText>{`${field.value.length}/${DISPLAY_NAME_MAX_LENGTH}`}</MutedText>
          )}
        </Card>

        {error ? (
          <Notice tone="danger" title="Couldn't save that">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        <Notice tone="info" title="Your photo stays on this phone for now">
          <MutedText>
            Profile photos upload through the same private, permission-checked pipeline as party
            media, which lands in Sprint 3. Until then your choice is remembered here and nothing
            leaves the device.
          </MutedText>
        </Notice>

        <Button
          label="Continue"
          icon="arrow-forward"
          onPress={() => void submit()}
          disabled={!field.valid || saving}
          busy={saving}
        />

        {/*
          The acceptance, next to the button that gives it.

          Play's UGC policy asks for terms that define and prohibit objectionable
          content *and* for the user to have agreed to them before they create
          any; a link buried in Settings is the first half only. `confirmProfile`
          sends `TERMS_VERSION` with the name, and an account with no accepted
          version is refused an upload grant, so this sentence and that refusal
          are the same rule seen from two sides.
        */}
        <Text style={styles.legal}>
          {TERMS_ACCEPTANCE_PROMPT}{" "}
          <Text
            style={styles.legalLink}
            accessibilityRole="link"
            onPress={() => void openLegalPage(TERMS_PATH)}
          >
            Read the terms
          </Text>
          {" · "}
          <Text
            style={styles.legalLink}
            accessibilityRole="link"
            onPress={() => void openLegalPage("/privacy")}
          >
            Privacy
          </Text>
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  legal: {
    ...typography.caption,
    color: colors.textFaint,
    textAlign: "center",
    paddingHorizontal: spacing.md,
  },
  legalLink: { color: colors.textMuted, textDecorationLine: "underline" },
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarInitial: { ...typography.display, color: colors.accent },
  avatarCopy: { flex: 1, gap: spacing.sm },
  label: { ...typography.label, color: colors.textMuted, textTransform: "uppercase" },
  input: {
    ...typography.title,
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
