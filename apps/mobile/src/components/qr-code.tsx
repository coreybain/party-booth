/**
 * A QR code, drawn with `View`s.
 *
 * Always dark-on-**white**, never themed, exactly as `apps/web`'s component is.
 * A phone camera needs a light quiet zone and a high-contrast target; this app's
 * canvas is near-black, and an inverted QR is readable by *some* scanners and not
 * others, which is the worst possible outcome at a door at 9pm.
 *
 * The value encoded is a **credential** — the invite token — so it is never put
 * in an accessibility label. `accessibilityLabel` says what the picture is for;
 * a screen reader announcing the URL would read the party's key out loud in a
 * room, and the six-digit code beneath it is the accessible route in.
 *
 * See `src/lib/qr-view.ts` for why this is not SVG.
 */

import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { qrGrid } from "@/lib/qr-view";
import { colors, radius, spacing, typography } from "@/theme";

export interface QrCodeProps {
  /** The exact string to encode — for PartyBooth, the absolute join URL. */
  readonly value: string;
  /** Drawing size in points. The matrix is scaled to fit inside it. */
  readonly size?: number;
  /** Accessible name. Never the value: it is a credential. */
  readonly label?: string;
}

const DEFAULT_SIZE = 220;

export function QrCode({ value, size = DEFAULT_SIZE, label = "Join QR code" }: QrCodeProps) {
  const grid = useMemo(() => qrGrid(value), [value]);

  if (grid === null) {
    return (
      <View style={[styles.fallback, { width: size, height: size }]}>
        <Text style={styles.fallbackText}>
          That link is too long for a QR code. Guests can still type the six-digit code.
        </Text>
      </View>
    );
  }

  // Floored so a module boundary never lands on a fractional pixel: a half-pixel
  // seam between two dark modules is a light line through the symbol, and some
  // scanners will refuse it.
  const unit = Math.max(1, Math.floor(size / grid.extent));
  const extent = unit * grid.extent;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.canvas, { width: extent, height: extent }]}
    >
      {grid.rows.map((row) => (
        <View key={row.y} style={[styles.row, { top: row.y * unit, height: unit }]}>
          {row.runs.map((run) => (
            <View
              key={run.x}
              style={[
                styles.module,
                { left: run.x * unit, width: run.length * unit, height: unit },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    backgroundColor: "#FFFFFF",
    borderRadius: radius.md,
    overflow: "hidden",
  },
  row: { position: "absolute", left: 0, right: 0 },
  module: { position: "absolute", top: 0, backgroundColor: "#000000" },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  fallbackText: { ...typography.caption, color: colors.textMuted, textAlign: "center" },
});
