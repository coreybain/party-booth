import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { Button, EmptyState, MutedText, Notice, Screen, ScreenHeader } from "@/components/ui";
import { parseJoinLink } from "@/lib/deep-links";
import { colors, radius, spacing, typography } from "@/theme";

import type { BarcodeScanningResult } from "expo-camera";

/** Scan the bearer QR from the host's sign and hand it to the existing join route. */
export default function ScanJoinRoute() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const scanLockedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const onBarcodeScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      // Camera callbacks can arrive multiple times in the same render frame. The
      // ref closes the gate synchronously; state alone only locks after React renders.
      if (scanLockedRef.current) return;
      scanLockedRef.current = true;
      setScanLocked(true);

      const target = parseJoinLink(data);
      if (!target) {
        setError("That QR code is not a PartyBooth invite.");
        return;
      }

      const token = target.kind === "token" ? target.token : target.code;
      router.replace({ pathname: "/join/[token]", params: { token } });
    },
    [router],
  );

  if (permission === null) {
    return (
      <ScanFrame>
        <EmptyState
          icon="camera-outline"
          title="Getting the scanner ready"
          body="One moment — checking whether PartyBooth can use this phone's camera."
        />
      </ScanFrame>
    );
  }

  if (!Device.isDevice) {
    return (
      <ScanFrame>
        <EmptyState
          icon="phone-portrait-outline"
          title="Scan on a phone"
          body="The simulator has no camera. Open PartyBooth on a phone, or enter the six-digit code instead."
          action={
            <Button
              label="Enter the code instead"
              icon="keypad-outline"
              onPress={() => router.replace("/join")}
            />
          }
        />
      </ScanFrame>
    );
  }

  if (!permission.granted) {
    return (
      <ScanFrame>
        <EmptyState
          icon={permission.canAskAgain ? "camera-outline" : "lock-closed-outline"}
          title={permission.canAskAgain ? "PartyBooth needs the camera" : "Camera access is off"}
          body={
            permission.canAskAgain
              ? "The camera is used only while this scanner is open. No image is saved or uploaded."
              : "Turn PartyBooth's camera back on in system Settings, then return to scan the sign."
          }
          action={
            permission.canAskAgain ? (
              <Button
                label="Allow the camera"
                icon="camera-outline"
                onPress={() => void requestPermission()}
              />
            ) : (
              <Button
                label="Open Settings"
                icon="settings-outline"
                variant="secondary"
                onPress={() => void Linking.openSettings()}
              />
            )
          }
        />
      </ScanFrame>
    );
  }

  return (
    <Screen edges={["left", "right", "bottom"]}>
      <View style={styles.content}>
        <ScreenHeader
          title="Scan the party QR"
          subtitle="Point the camera at the QR code on the host's sign."
        />

        <View style={styles.scanner}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanLocked ? undefined : onBarcodeScanned}
          />
          <View pointerEvents="none" style={styles.guide} />
          <View pointerEvents="none" style={styles.scannerCaption}>
            <Text style={styles.scannerCaptionText}>Hold steady inside the frame</Text>
          </View>
        </View>

        {error ? (
          <Notice tone="warning" title="QR code not recognised">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        {scanLocked && error ? (
          <Button
            label="Scan again"
            icon="scan-outline"
            onPress={() => {
              setError(null);
              scanLockedRef.current = false;
              setScanLocked(false);
            }}
          />
        ) : null}

        <Button
          label="Enter the code instead"
          icon="keypad-outline"
          variant="secondary"
          onPress={() => router.replace("/join")}
        />
      </View>
    </Screen>
  );
}

function ScanFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <Screen edges={["left", "right", "bottom"]}>
      <View style={styles.content}>{children}</View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  scanner: {
    flex: 1,
    minHeight: 320,
    overflow: "hidden",
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  guide: {
    position: "absolute",
    width: "68%",
    aspectRatio: 1,
    alignSelf: "center",
    top: "16%",
    borderWidth: 3,
    borderRadius: radius.lg,
    borderColor: colors.accent,
  },
  scannerCaption: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    alignItems: "center",
  },
  scannerCaptionText: {
    ...typography.label,
    color: colors.text,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
