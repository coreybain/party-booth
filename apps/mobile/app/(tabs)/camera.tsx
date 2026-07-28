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
 * Hold the shutter to record, up to sixty seconds, release to stop. The gesture
 * itself is a pure state machine in `src/lib/shutter.ts` — this screen owns only
 * the promises and the one awkward fact that makes it non-trivial:
 * **`expo-camera` records only in `mode="video"`, and changing `mode` rebuilds
 * the capture session.** So the machine has an `arming` phase, the screen flips
 * `mode` on entering it, and `recordAsync` is called when `onCameraReady` fires
 * again — not after a guessed delay. The recording ring therefore starts when
 * the recorder started, so the sixty seconds a guest watches is the sixty
 * seconds they get.
 *
 * The camera stays in `mode="picture"` at rest, which is what keeps the tap path
 * exactly as fast as it was in Sprint 3.
 */

import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import * as Device from "expo-device";
import { useIsFocused, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import {
  FlashButton,
  FlipButton,
  LibraryButton,
  PendingBadge,
  RecordingIndicator,
  ShutterButton,
  TorchButton,
  type FlashMode,
} from "@/components/camera-controls";
import { UndoPill } from "@/components/undo-pill";
import { Button, EmptyState, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { useCapture } from "@/hooks/use-capture";
import { describeEventState } from "@/lib/events";
import { useShutter, type RecordedClip } from "@/hooks/use-shutter";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { useUploadQueue } from "@/upload/queue-provider";
import { colors, radius, spacing, typography } from "@/theme";

import { VIDEO_MAX_DURATION_SECONDS } from "@partybooth/contracts/media";

import type { CameraType } from "expo-camera";
import type { ReactNode } from "react";

/**
 * The one line under the controls.
 *
 * `accessibilityHint` on the shutter says the same thing, but a hint is read
 * only by a screen reader and only after a pause — which leaves a sighted guest
 * to discover the gesture by holding a button. Saying it on screen is cheaper
 * than the discovery.
 */
export const SHUTTER_HINT = `Tap for a photo. Hold to record video, up to ${String(VIDEO_MAX_DURATION_SECONDS)} seconds.`;

/** What the shutter says when the microphone has been refused. */
export const SHUTTER_HINT_NO_VIDEO = "Tap for a photo.";

const PICKER_FAILED = "That photo couldn't be opened. Try choosing it again.";
const MICROPHONE_REFUSED =
  "Video needs the microphone, and PartyBooth doesn't have it. Turn it on in Settings if you'd like to record clips — photos work either way.";

export default function CameraScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const { activeEvent, eventsLoading } = useSession();
  const queue = useUploadQueue();
  const { busy, capture, captureVideo } = useCapture(activeEvent);

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [microphone, requestMicrophone] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [torch, setTorch] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  /** One transient sentence under the controls — always a refusal, verbatim. */
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

  /*
   * Video is offered only once the microphone has actually been granted.
   *
   * `recordAudioAndroid: true` in the config plugin means a recording without
   * the permission fails outright rather than producing a silent clip, so a
   * shutter that offered the hold gesture would be offering a gesture that
   * cannot work. `null` is "not read yet" and is treated as "not yet" — the hint
   * corrects itself within a frame of the OS answering.
   */
  const videoEnabled = microphone?.granted === true;

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

  /* ---------------------------------------------------------------- */
  /* Recording                                                        */
  /* ---------------------------------------------------------------- */

  const onClip = useCallback(
    (clip: RecordedClip) => {
      void (async () => {
        const outcome = await captureVideo({
          source: { uri: clip.uri, durationSeconds: clip.durationSeconds },
          capturedAt: clip.startedAt,
        });
        setNotice(outcome.status === "refused" ? outcome.message : null);
      })();
    },
    [captureVideo],
  );

  /*
   * Never leave the torch burning after a clip. It is the single most visible
   * way to flatten a phone at a party, and it has to happen on the failure path
   * too — which is why the hook calls it rather than the success branch here.
   */
  const onRecordingEnd = useCallback(() => setTorch(false), []);

  const shutter = useShutter({
    camera: cameraRef,
    onPhoto: onShutter,
    onClip,
    onError: setNotice,
    onRecordingEnd,
    // The tab losing focus, the preview erroring, the party pausing mid-hold.
    // None of them produce a release event, so the hook has to be told.
    disabled: !isFocused || !uploadsOpen || mountError !== null || !hasCamera,
    // Photos still work without the microphone; a hold simply stays a tap.
    videoEnabled,
  });

  const recording = shutter.recording;

  const onFlip = useCallback(() => {
    // Flipping mid-recording stops it on both platforms, so the control is
    // disabled while recording rather than being allowed to end a clip by
    // surprise. This is the belt for that braces.
    if (recording) return;
    setFacing((current) => (current === "back" ? "front" : "back"));
  }, [recording]);

  /**
   * Ask for the microphone the first time video is plausible.
   *
   * Not on mount: a permission prompt is the first thing a guest sees on the
   * Camera tab and asking for two at once reads as greedy. This fires when the
   * guest reaches for video without the permission, which is the moment the
   * request explains itself.
   */
  const onRequestMicrophone = useCallback(() => {
    void (async () => {
      const result = await requestMicrophone();
      if (!result.granted) setNotice(MICROPHONE_REFUSED);
    })();
  }, [requestMicrophone]);

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

  // While recording, the button is the *stop* control and must stay live even
  // though `shutter.ready` was reset by the mode flip.
  const shutterDisabled =
    !recording && (!uploadsOpen || !hasCamera || mountError !== null || !shutter.ready);

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
            // Flipped by the shutter machine's `arming` phase and back again when
            // the clip is done. `recordAsync` refuses in `picture` mode, and
            // changing this rebuilds the capture session — which is exactly why
            // `arming` exists and why `onCameraReady` is what starts the
            // recorder rather than a delay.
            mode={shutter.videoMode ? "video" : "picture"}
            videoQuality="1080p"
            /*
             * Derived rather than stored, so the torch physically cannot be on
             * when there is nothing recording: the control that toggles it only
             * exists during a recording, and a torch with no visible off switch
             * is the fastest way to flatten a phone at a party. `onRecordingEnd`
             * also clears the state, which covers the failure path.
             */
            enableTorch={torch && recording}
            // The camera session stops when the guest moves to Photos or Host.
            // A live capture session behind another tab is battery and a hot
            // phone for a preview nobody is looking at.
            active={isFocused}
            onCameraReady={shutter.onCameraReady}
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
            {recording ? (
              <RecordingIndicator seconds={shutter.seconds} remaining={shutter.remaining} />
            ) : null}
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
              {/* The flash fires for a still and does nothing during a recording,
                  so the two controls swap rather than sitting side by side —
                  whichever one is on screen is the one that will do something. */}
              {recording ? (
                <TorchButton on={torch} onToggle={setTorch} />
              ) : (
                <FlashButton
                  mode={flash}
                  onChange={setFlash}
                  disabled={!hasCamera || mountError !== null}
                />
              )}
              <ShutterButton
                onPressIn={shutter.onPressIn}
                onPressOut={shutter.onPressOut}
                recording={recording}
                progress={shutter.progress}
                disabled={shutterDisabled}
                busy={busy}
                videoEnabled={videoEnabled}
              />
              <FlipButton
                onPress={onFlip}
                disabled={!hasCamera || mountError !== null || recording}
              />
              {/* Gated on the *event's* flag, which is a live field on the
                  `events.myEvents` subscription — a host turning library
                  imports off mid-party removes this button without a restart.
                  `checkGrantEligibility` refuses the same import server-side,
                  so this is the affordance, not the enforcement. */}
              {allowLibrary && !recording ? (
                <LibraryButton onPress={onLibrary} disabled={busy} />
              ) : null}
            </View>

            {videoEnabled || !hasCamera ? (
              <Text style={styles.hint}>{videoEnabled ? SHUTTER_HINT : SHUTTER_HINT_NO_VIDEO}</Text>
            ) : (
              // Not a blocking gate: photographs work perfectly well without the
              // microphone, so this is an offer rather than a wall.
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Allow the microphone to record video"
                onPress={onRequestMicrophone}
                hitSlop={8}
              >
                <Text style={[styles.hint, styles.hintAction]}>
                  Tap for a photo. To record video, allow the microphone.
                </Text>
              </Pressable>
            )}
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
  hintAction: { color: colors.accentSoft, textDecorationLine: "underline" },
});
