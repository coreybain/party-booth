"use client";

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { encodeQr, qrPath, qrViewBoxSize } from "@/lib/contracts";

export interface QrCodeProps {
  /** The exact string to encode — for PartyBooth, the absolute join URL. */
  readonly value: string;
  /** Accessible name. The URL itself is never announced: it is a credential. */
  readonly label: string;
  readonly className?: string;
}

/**
 * A QR code as inline SVG.
 *
 * SVG rather than canvas so it stays crisp when the host zooms in on a phone,
 * prints the page, or drags it onto a slide — TODO.md Sprint 7 has the QR going
 * onto paper signage, and a raster at the wrong DPI is the classic way that
 * goes wrong.
 *
 * Always drawn dark-on-**white**, never themed. A phone camera needs a light
 * quiet zone and a high-contrast target, and this app's canvas is near-black;
 * an inverted QR is readable by some scanners and not others, which is the
 * worst possible outcome at a door.
 *
 * Encoding a version-5 symbol costs about a millisecond, and `useMemo` keeps it
 * off the path of every unrelated re-render.
 */
export function QrCode({ value, label, className }: QrCodeProps) {
  const svg = useMemo(() => {
    try {
      const matrix = encodeQr(value);
      return { path: qrPath(matrix), extent: qrViewBoxSize(matrix) };
    } catch {
      // Capacity is the only failure, and only for an absurdly long origin.
      // The code and the typed URL still work, so degrade rather than crash.
      return null;
    }
  }, [value]);

  if (svg === null) {
    return (
      <div
        className={cn(
          "grid aspect-square w-full place-items-center rounded-2xl border border-dashed",
          "border-line bg-surface p-4 text-center text-sm text-muted",
          className,
        )}
      >
        That link is too long to put in a QR code. Guests can still type the six-digit code.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${String(svg.extent)} ${String(svg.extent)}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn("h-auto w-full rounded-2xl bg-white", className)}
    >
      <path d={svg.path} fill="#000000" />
    </svg>
  );
}
