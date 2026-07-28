/**
 * Camera tab — the viewfinder, the shutter, and the undo window.
 *
 * This screen owns almost no logic. Everything it does is assembled from parts
 * that already existed and were already tested:
 *
 * | part                         | where it lives                        |
 * | ---------------------------- | ------------------------------------- |
 * | shutter → durable queue      | `src/hooks/use-capture.ts`            |
 * | encode + strip EXIF          | `src/upload/media-pipeline.ts`        |
 * | the queue, retries, resume   | `src/upload/queue-provider.tsx`       |
 * | the controls                 | `src/components/camera-controls.tsx`  |
 * | the countdown                | `src/components/undo-pill.tsx`        |
 * | may this event take uploads  | `@partybooth/contracts/events`        |
 * | may this *file* be sent      | `@partybooth/contracts/upload`        |
 *
 * What is left here is the five states a viewfinder actually has, and which one
 * is on screen: asking for permission, refused permission, no camera at all
 * (a simulator), a party that is not taking photographs, and a working camera.
 * Every one of them is reachable in normal use, and each says what to do next.
 *
 * ## Library choice — expo-camera, not react-native-vision-camera
 *
 * Rationale in `apps/mobile/README.md` → "Camera". The short version: launch
 * scope is a *clean* camera (tap photo, hold video, flash, flip, both
 * orientations), `CameraView` covers all of it, and it is version-locked to the
 * SDK so an EAS dev-client build cannot drift. Effects are post-launch
 * (PLAN.md → P3) and that is when vision-camera + Skia earns its extra native
 * surface, behind the `CameraEffectsAdapter` seam the plan already calls for.
 *
 * ## Orientation
 *
 * The app allows both (`orientation: "default"` in app.config.ts), so the whole
 * UI turns with the device and the *layout* moves the controls to the short
 * edge. Nothing counter-rotates: rotating icons inside a rotating view is how
 * labels end up upside down. `responsiveOrientationWhenOrientationLocked` is
 * deliberately **not** set — it exists for apps whose orientation is pinned,
 * and this one's is not.
 *
 * ## Video
 *
 * `mode="picture"`. Hold-to-record is Sprint 4 (PLAN.md), and the hold gesture
 * answers rather than doing nothing — a guest will absolutely try it, and
 * silence reads as a broken button.
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useIsFocused, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import {
  FlashButton,
  FlipButton,
  LibraryButton,
  PendingBadge,
  ShutterButton,
  type FlashMode,
} from "@/components/camera-controls";
import { UndoPill } from "@/components/undo-pill";
import { Button, EmptyState, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { useCapture } from "@/hooks/use-capture";
import { describeEventState } from "@/lib/events";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { useUploadQueue } from "@/upload/queue-provider";
import { colors, radius, spacing, typography } from "@/theme";

import type { CameraType } from "expo-camera";
import type { ReactNode } from "react";

/**
 * What the hold gesture says until Sprint 4 lands.
 *
 * Named rather than inlined so the test can assert on the promise rather than
 * on a string literal typed twice.
 */
export const VIDEO_COMING_SOON =
  "Hold-to-record video is coming in the next update. Tap for a photo for now.";

/**
 * The one line under the controls.
 *
 * `accessibilityHint` on the shutter says the same thing, but a hint is read
 * only by a screen reader and only after a pause — which leaves a sighted guest
 * to discover the gesture by holding a button and getting an apology. Saying it
 * on screen is cheaper than the disappointment.
 */
export const SHUTTER_HINT = "Tap for a photo. Hold for video — coming in the next update.";

const PICKER_FAILED = "That photo couldn't be opened. Try choosing it again.";

export default function CameraScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const { activeEvent, eventsLoading } = useSession();
  const queue = useUploadQueue();
  const { busy, capture } = useCapture(activeEvent);

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  /** One transient sentence under the controls: a refusal, or "coming soon". */
  const [notice, setNotice] = useState<string | null>(null);

  // A simulator has no camera and `CameraView` fails to mount on it. Knowing
  // that *before* rendering the preview turns a black rectangle and a console
  // error into an explanation — and the library path still works there, which
  // is how the whole upload spine gets exercised without a physical device.
  const hasCamera = Device.isDevice;

  const description = activeEvent ? describeEventState(activeEvent.state) : null;
  const uploadsOpen = description?.acceptsUploads === true;
  const pending = queue.pendingFor(activeEvent?.id);
  const undoable = queue.undoableFor(activeEvent?.id);
  const allowLibrary = activeEvent?.allowLibraryImport === true;

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const runCapture = useCallback(
    async (source: { uri: string; width?: number; height?: number }, fromLibrary: boolean) => {
      const outcome = await capture({ source, fromLibrary, capturedAt: Date.now() });
      // A refusal is a value, never a thrown error (ADR 0004 §2), and it arrives
      // pre-worded for a guest — so it is shown verbatim rather than re-phrased.
      setNotice(outcome.status === "refused" ? outcome.message : null);
    },
    [capture],
  );

  const onShutter = useCallback(() => {
    void (async () => {
      const camera = cameraRef.current;
      if (camera === null) return;
      try {
        // `exif: false` is belt to the pipeline's braces: the re-encode in
        // `media-pipeline` is what actually guarantees no GPS fix leaves the
        // phone, but there is no reason to carry the block that far.
        // `skipProcessing: false` keeps the frame the right way up.
        const photo = await camera.takePictureAsync({
          quality: 1,
          exif: false,
          skipProcessing: false,
        });
        if (photo === undefined) return;
        await runCapture({ uri: photo.uri, width: photo.width, height: photo.height }, false);
      } catch (error) {
        captureHandledError(error, { scope: "camera.takePicture" });
        setNotice("The camera didn't manage that one. Try again.");
      }
    })();
  }, [runCapture]);

  const onLibrary = useCallback(() => {
    void (async () => {
      try {
        // Imported on demand: the picker pulls a native module a guest who never
        // opens it should not pay to load, and this matches `(auth)/onboarding`.
        const ImagePicker = await import("expo-image-picker");
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsMultipleSelection: false,
          exif: false,
          quality: 1,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (asset === undefined) return;
        await runCapture({ uri: asset.uri, width: asset.width, height: asset.height }, true);
      } catch (error) {
        captureHandledError(error, { scope: "camera.library" });
        setNotice(PICKER_FAILED);
      }
    })();
  }, [runCapture]);

  const onHold = useCallback(() => setNotice(VIDEO_COMING_SOON), []);
  const onFlip = useCallback(() => {
    setFacing((current) => (current === "back" ? "front" : "back"));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Gates, outermost first                                           */
  /* ---------------------------------------------------------------- */

  // `null` means the native permission has not been read yet. Rendering the
  // "allow the camera" prompt during that beat would flash it at every guest
  // who has already granted it, on every cold start.
  if (permission === null) {
    return (
      <CameraFrame>
        <EmptyState
          icon="camera-outline"
          title="Getting the camera ready"
          body="One moment — checking whether PartyBooth can use this phone's camera."
        />
      </CameraFrame>
    );
  }

  if (!permission.granted) {
    return (
      <CameraFrame>
        {permission.canAskAgain ? (
          <EmptyState
            icon="camera-outline"
            title="PartyBooth needs the camera"
            body="It is only ever used while this screen is open, and a photo is only sent to the party you joined."
            action={
              <Button
                label="Allow the camera"
                icon="camera-outline"
                onPress={() => void requestPermission()}
              />
            }
          />
        ) : (
          <EmptyState
            icon="lock-closed-outline"
            title="Camera access is off"
            body="iOS and Android only ask once. Turn PartyBooth's camera back on in the system Settings app, then come back to this tab."
            action={
              <Button
                label="Open Settings"
                variant="secondary"
                icon="settings-outline"
                onPress={() => void Linking.openSettings()}
              />
            }
          />
        )}
      </CameraFrame>
    );
  }

  if (!activeEvent && !eventsLoading) {
    return (
      <CameraFrame>
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
      </CameraFrame>
    );
  }

  /* ---------------------------------------------------------------- */
  /* The viewfinder                                                   */
  /* ---------------------------------------------------------------- */

  const shutterDisabled = !uploadsOpen || !hasCamera || mountError !== null || !ready;

  return (
    // Full-bleed and edge-to-edge: the tab shell's header owns the notch, and a
    // viewfinder with a margin around it looks like a bug rather than a frame.
    <Screen edges={["left", "right"]} style={styles.screen}>
      <View style={styles.stage}>
        {hasCamera && mountError === null ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            mode="picture"
            // The camera session stops when the guest moves to Photos or Host.
            // A live capture session behind another tab is battery and a hot
            // phone for a preview nobody is looking at.
            active={isFocused}
            onCameraReady={() => setReady(true)}
            onMountError={(event) => {
              captureHandledError(new Error(event.message), { scope: "camera.mount" });
              setMountError(event.message);
            }}
          />
        ) : (
          <View style={styles.fallback}>
            <ScreenHeader
              title="No camera here"
              subtitle={
                mountError === null
                  ? `This ${Platform.OS === "ios" ? "simulator" : "emulator"} has no camera. Everything else works — add a photo from the library to exercise the upload path.`
                  : "The camera could not start on this device. Adding a photo from the library still works."
              }
            />
          </View>
        )}

        {/* Overlays. Order matters: the pill sits above the controls so a long
            filename or a long refusal cannot push the shutter off screen. */}
        <View style={styles.overlay}>
          <View style={styles.topRow}>
            <PendingBadge count={pending} />
          </View>

          <View style={styles.bottom}>
            {description && !uploadsOpen ? (
              <Notice tone="warning" title={description.label}>
                <MutedText>{description.detail}</MutedText>
              </Notice>
            ) : null}

            {queue.offline ? (
              <Notice tone="info" title="Nothing can be sent from this build">
                <MutedText>
                  There is no backend configured, so captures are kept on this phone and never
                  uploaded.
                </MutedText>
              </Notice>
            ) : null}

            {notice !== null ? (
              <Notice tone="info" title="Just so you know">
                <MutedText>{notice}</MutedText>
              </Notice>
            ) : null}

            {undoable ? (
              <UndoPill
                item={undoable}
                onUndo={() => queue.undo(undoable.captureId)}
                onSendNow={() => queue.sendNow(undoable.captureId)}
              />
            ) : null}

            <View style={[styles.controls, landscape && styles.controlsLandscape]}>
              <FlashButton
                mode={flash}
                onChange={setFlash}
                disabled={!hasCamera || mountError !== null}
              />
              <ShutterButton
                onPress={onShutter}
                onHold={onHold}
                disabled={shutterDisabled}
                busy={busy}
              />
              <FlipButton onPress={onFlip} disabled={!hasCamera || mountError !== null} />
              {/* Gated on the *event's* flag, which is a live field on the
                  `events.myEvents` subscription — a host turning library
                  imports off mid-party removes this button without a restart.
                  `checkGrantEligibility` refuses the same import server-side,
                  so this is the affordance, not the enforcement. */}
              {allowLibrary ? <LibraryButton onPress={onLibrary} disabled={busy} /> : null}
            </View>

            <Text style={styles.hint}>{SHUTTER_HINT}</Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

/** The non-viewfinder states, in the same box the viewfinder would occupy. */
function CameraFrame({ children }: { children: ReactNode }) {
  return (
    <Screen edges={["left", "right"]}>
      <View style={styles.frame}>{children}</View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: 0 },
  frame: { flex: 1, justifyContent: "center" },
  stage: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  fallback: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "space-between",
    // On `style` rather than as a prop: the `pointerEvents` prop is deprecated
    // in React Native 0.86. `box-none` lets a tap fall through the empty parts
    // of the overlay to the preview beneath it (focus, in a later sprint) while
    // the controls themselves stay tappable.
    pointerEvents: "box-none",
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    padding: spacing.lg,
    pointerEvents: "box-none",
  },
  bottom: { padding: spacing.lg, gap: spacing.md, pointerEvents: "box-none" },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: "rgba(18, 9, 27, 0.45)",
  },
  // In landscape the short edge is the bottom one, so the row tightens toward
  // the middle rather than stretching a shutter to the far corners of a phone
  // held sideways — both thumbs are near the centre.
  controlsLandscape: { alignSelf: "center", justifyContent: "center", gap: spacing.xl },
  hint: { ...typography.caption, color: colors.textMuted, textAlign: "center" },
});
