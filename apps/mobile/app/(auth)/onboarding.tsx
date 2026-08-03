import { TERMS_ACCEPTANCE_PROMPT, TERMS_PATH } from "@partybooth/contracts/terms";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Redirect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { BodyText, Button, Card, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { appConfig } from "@/env";
import { captureHandledError } from "@/lib/sentry";
import { DISPLAY_NAME_MAX_LENGTH, initialFor, readDisplayName } from "@/lib/profile";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/**
 * Name + photo confirmation (PLAN.md → "Guests in app: Apple or Google sign-in, then
 * name + photo confirmation").
 *
 * `confirmProfile` writes the display name to Convex and sends a selected photo
 * through the private, single-use avatar upload path. Clients receive only a
 * short-lived signed read URL; the provider key never crosses this screen.
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
  const { state, localProfile, confirmProfile, acceptCurrentTerms } = useSession();

  const providerName = state.status === "signed-in" ? (state.user.name ?? "") : "";
  const providerImage = state.status === "signed-in" ? state.user.image : null;

  const [name, setName] = useState(providerName);
  const [touched, setTouched] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(localProfile.photoUri ?? providerImage);
  // Provider/server images are already remote. Only a picker URI (or a legacy
  // local choice from an earlier build) needs to travel through the avatar pipeline.
  const [photoNeedsUpload, setPhotoNeedsUpload] = useState(localProfile.photoUri !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = readDisplayName(name, touched);

  const pickPhoto = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
        setPhotoNeedsUpload(true);
      }
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
    const outcome = await confirmProfile({
      displayName: validated.value,
      photoUri: photoNeedsUpload ? photoUri : null,
    });
    setSaving(false);

    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }
    // Back through the entry gate rather than straight to a tab: `needsOnboarding`
    // has just flipped, so `/` falls through — and it is the only place that knows
    // whether an invite was parked while this guest signed in.
    router.replace("/");
  }, [confirmProfile, name, photoNeedsUpload, photoUri, router]);

  if (state.status === "signed-out") return <Redirect href="/sign-in" />;
  if (state.status === "loading") return <Redirect href="/" />;

  // New accounts accept beside the profile confirmation below. This branch is
  // deliberately only for an established account whose recorded version is
  // missing or stale, so accepting a policy update never asks for their name or
  // avatar again.
  if (!state.needsOnboarding && state.needsTermsAcceptance) {
    return (
      <TermsAcceptanceScreen
        acceptCurrentTerms={acceptCurrentTerms}
        onAccepted={() => router.replace("/")}
      />
    );
  }

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

        <Notice tone="info" title="Private by default">
          <MutedText>
            Your photo is re-sized before it is sent to private storage. Party members receive a
            short-lived link only when they can see something you shared.
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

function TermsAcceptanceScreen({
  acceptCurrentTerms,
  onAccepted,
}: {
  readonly acceptCurrentTerms: () => Promise<
    { readonly status: "ok" } | { readonly status: "error"; readonly message: string }
  >;
  readonly onAccepted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(async () => {
    setSaving(true);
    setError(null);
    const outcome = await acceptCurrentTerms();
    setSaving(false);
    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }
    onAccepted();
  }, [acceptCurrentTerms, onAccepted]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="The PartyBooth terms have changed"
          subtitle="Please review and accept the current rules before adding anything to a party."
        />

        <Card>
          <BodyText>{TERMS_ACCEPTANCE_PROMPT}</BodyText>
          <MutedText>
            The rules cover objectionable content, other people&apos;s privacy, reporting and
            blocking. Your name, photo and party memberships will not change.
          </MutedText>
          <Button
            label="Read the current terms"
            variant="secondary"
            icon="document-text-outline"
            onPress={() => void openLegalPage(TERMS_PATH)}
            disabled={saving || appConfig.status !== "ready"}
          />
        </Card>

        {error ? (
          <Notice tone="danger" title="Couldn't record your agreement">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        <Button
          label="Agree and continue"
          icon="checkmark"
          onPress={() => void accept()}
          disabled={saving}
          busy={saving}
        />
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
