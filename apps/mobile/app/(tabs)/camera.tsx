import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  Badge,
  BodyText,
  Button,
  Card,
  EmptyState,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { describeEventState } from "@/lib/events";
import { useSession } from "@/providers/session";
import { colors, spacing } from "@/theme";

/**
 * Camera tab — placeholder.
 *
 * The real capture surface is Sprint 3 (photo) and Sprint 4 (hold-to-record video).
 * What this screen does today is prove the native camera module is actually linked into
 * the dev-client build: `useCameraPermissions` / `useMicrophonePermissions` are native
 * calls, so if this screen renders a real status, the build is sound. That is exactly
 * the check RC1 asks for ("Expo dev build installs and opens on your phone").
 *
 * Library choice — expo-camera, not react-native-vision-camera. Rationale in
 * apps/mobile/README.md; the short version is that launch scope is a *clean* camera
 * (tap photo, hold video, flash, flip, both orientations), expo-camera covers all of it,
 * and it is version-locked to the SDK so an EAS dev-client build cannot drift. Effects
 * are post-launch (PLAN.md → P3), and that is when vision-camera + Skia earns its extra
 * native surface — behind the `CameraEffectsAdapter` seam the plan already calls for.
 */
export default function CameraScreen() {
  const router = useRouter();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const { activeEvent, eventsLoading } = useSession();

  const cameraGranted = cameraPermission?.granted === true;
  const micGranted = micPermission?.granted === true;
  const ready = cameraGranted && micGranted;

  // The camera has to have somewhere to send to. Which is a state question, not a
  // permission one, and `@partybooth/contracts/events` owns the answer: `live` is the
  // only state that accepts uploads.
  const description = activeEvent ? describeEventState(activeEvent.state) : null;

  return (
    // The tab shell renders the header (and owns the notch), so this screen keeps
    // only the horizontal safe-area edges.
    <Screen edges={["left", "right"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Camera" subtitle="Tap for a photo, hold for video — from Sprint 3." />

        {!activeEvent && !eventsLoading ? (
          <EmptyState
            icon="qr-code-outline"
            title="Join a party first"
            body="Scan the QR code on the host's sign, or type the six-digit code printed under it. Everything you capture goes to the party you're in."
            action={
              <Button
                label="Enter a join code"
                icon="keypad-outline"
                onPress={() => router.push("/join")}
              />
            }
          />
        ) : null}

        {activeEvent && description && !description.acceptsUploads ? (
          <Notice tone="warning" title={description.label}>
            <MutedText>{description.detail}</MutedText>
          </Notice>
        ) : null}

        <View style={styles.viewfinder}>
          <EmptyState
            icon="camera-outline"
            title="Viewfinder lands in Sprint 3"
            body="Capture, the 15-second undo window, and the durable upload queue are built on the upload spine. This tab is the shell those controls mount into."
          />
        </View>

        <Card>
          <Badge
            label={ready ? "permissions ready" : "permissions needed"}
            tone={ready ? colors.success : colors.warning}
          />
          <BodyText>
            Granting these now confirms the dev-client build has the native camera module linked.
          </BodyText>

          <View style={styles.permissionRow}>
            <MutedText>
              {`Camera: ${describePermission(cameraPermission?.granted, cameraPermission?.canAskAgain)}`}
            </MutedText>
            {!cameraGranted ? (
              <Button
                label="Grant camera access"
                variant="secondary"
                icon="camera-outline"
                onPress={() => void requestCameraPermission()}
                disabled={cameraPermission?.canAskAgain === false}
              />
            ) : null}
          </View>

          <View style={styles.permissionRow}>
            <MutedText>
              {`Microphone: ${describePermission(micPermission?.granted, micPermission?.canAskAgain)}`}
            </MutedText>
            {!micGranted ? (
              <Button
                label="Grant microphone access"
                variant="secondary"
                icon="mic-outline"
                onPress={() => void requestMicPermission()}
                disabled={micPermission?.canAskAgain === false}
              />
            ) : null}
          </View>
        </Card>

        {cameraPermission?.canAskAgain === false && !cameraGranted ? (
          <Notice tone="warning" title="Camera access was denied">
            <MutedText>
              iOS and Android only ask once. Re-enable PartyBooth&apos;s camera access in the system
              Settings app, then come back.
            </MutedText>
          </Notice>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function describePermission(
  granted: boolean | undefined,
  canAskAgain: boolean | undefined,
): string {
  if (granted === undefined) return "checking…";
  if (granted) return "granted";
  return canAskAgain === false ? "denied (change it in system Settings)" : "not granted yet";
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  viewfinder: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderStyle: "dashed",
    backgroundColor: colors.surface,
    justifyContent: "center",
  },
  permissionRow: { gap: spacing.sm },
});
