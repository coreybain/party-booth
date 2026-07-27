import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Badge, Button, Card, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/**
 * Name + photo confirmation (PLAN.md → "Guests in app: Apple or Google sign-in, then
 * name + photo confirmation").
 *
 * Sprint 1 is the shell: the form works locally, but there is no Convex mutation to
 * persist to yet and no UploadThing grant to send an avatar through. Both land in
 * Sprint 2/3 — see the TODOs on `submit` and `pickPhoto`.
 */

const NAME_MAX_LENGTH = 40;

export default function OnboardingScreen() {
  const router = useRouter();
  const { state } = useSession();

  const initialName = state.status === "signed-in" ? (state.user.name ?? "") : "";
  const initialImage = state.status === "signed-in" ? state.user.image : null;

  const [name, setName] = useState(initialName);
  const [photoUri, setPhotoUri] = useState<string | null>(initialImage);
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length >= 2 && !saving;

  const pickPhoto = useCallback(async () => {
    // TODO(Sprint 3): expo-image-picker → UploadThing grant → Convex user.image.
    // Deliberately not wired here: avatars share the upload-grant pipeline that Sprint 3
    // builds, and a second ad-hoc upload path would have to be deleted again.
    const ImagePicker = await import("expo-image-picker");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) setPhotoUri(result.assets[0].uri);
  }, []);

  const submit = useCallback(() => {
    // TODO(Sprint 2): call the Convex `users.completeOnboarding` mutation with
    // { displayName, imageStorageId } and let the session's `needsOnboarding` flip from
    // the server. Until then this only advances the local shell.
    setSaving(true);
    router.replace("/camera");
  }, [router]);

  if (state.status === "signed-out") return <Redirect href="/sign-in" />;
  if (state.status === "loading") return <Redirect href="/" />;

  const initial = (trimmed[0] ?? "?").toUpperCase();

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
                <Text style={styles.avatarInitial}>{initial}</Text>
              )}
            </Pressable>
            <View style={styles.avatarCopy}>
              <Button
                label={photoUri ? "Change photo" : "Add a photo"}
                variant="secondary"
                icon="image-outline"
                onPress={() => void pickPhoto()}
              />
              <MutedText>Optional. You can add one later from Settings.</MutedText>
            </View>
          </View>
        </Card>

        <Card>
          <Text style={styles.label}>Display name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            maxLength={NAME_MAX_LENGTH}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="done"
            accessibilityLabel="Display name"
          />
          <MutedText>{`${trimmed.length}/${NAME_MAX_LENGTH}`}</MutedText>
        </Card>

        <Notice tone="info" title="Shell only">
          <Badge label="sprint 2" />
          <MutedText>
            Saving is not wired to Convex yet, so this only advances the local shell. Photo upload
            follows the same short-lived grant pipeline as party media (Sprint 3).
          </MutedText>
        </Notice>

        <Button
          label="Continue"
          icon="arrow-forward"
          onPress={submit}
          disabled={!canSubmit}
          busy={saving}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
});
