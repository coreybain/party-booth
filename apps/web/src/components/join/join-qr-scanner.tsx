"use client";

import jsQR from "jsqr";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { QrIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { inviteTokenFromQr } from "@/lib/qr-invite";

type ScannerStatus = "idle" | "starting" | "active" | "error";

const MAX_SCAN_WIDTH = 720;
const SCAN_INTERVAL_MS = 120;

export function JoinQrScanner({ onEnterCode }: { readonly onEnterCode: () => void }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastScanAtRef = useRef(0);
  const scanLockedRef = useRef(false);
  const lastRejectedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const releaseCamera = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => releaseCamera, [releaseCamera]);

  const startCamera = useCallback(async () => {
    if (status === "starting" || status === "active") return;

    setStatus("starting");
    setMessage(null);
    scanLockedRef.current = false;
    lastRejectedRef.current = null;
    lastScanAtRef.current = 0;

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setMessage("This browser can’t open a camera here. Enter the six-digit code instead.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        releaseCamera();
        return;
      }

      video.srcObject = stream;
      await video.play();
      setStatus("active");

      const scanFrame = (timestamp: number) => {
        if (scanLockedRef.current) return;

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { willReadFrequently: true });
        const readyForNextScan = timestamp - lastScanAtRef.current >= SCAN_INTERVAL_MS;
        if (
          readyForNextScan &&
          canvas &&
          context &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          lastScanAtRef.current = timestamp;
          const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
          const width = Math.max(1, Math.round(video.videoWidth * scale));
          const height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);

          const pixels = context.getImageData(0, 0, width, height);
          const result = jsQR(pixels.data, width, height, { inversionAttempts: "dontInvert" });
          if (result) {
            const token = inviteTokenFromQr(result.data);
            if (token) {
              scanLockedRef.current = true;
              releaseCamera();
              router.push(`/join/${encodeURIComponent(token)}`);
              return;
            }

            if (lastRejectedRef.current !== result.data) {
              lastRejectedRef.current = result.data;
              setMessage("That QR code isn’t a PartyBooth invite. Try the code on the sign.");
            }
          }
        }

        frameRef.current = requestAnimationFrame(scanFrame);
      };

      frameRef.current = requestAnimationFrame(scanFrame);
    } catch (error) {
      releaseCamera();
      setStatus("error");
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera access is off. Allow it in your browser settings, or enter the code instead."
          : "The camera couldn’t start. Enter the six-digit code instead.",
      );
    }
  }, [releaseCamera, router, status]);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setStatus("idle");
    setMessage(null);
  }, [releaseCamera]);

  const chooseCode = useCallback(() => {
    releaseCamera();
    onEnterCode();
  }, [onEnterCode, releaseCamera]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Scan the event QR</h1>
        <p className="mt-1 text-sm text-muted">
          Point your camera at the QR code on the host’s sign.
        </p>
      </div>

      <div className="relative aspect-square overflow-hidden rounded-2xl border border-line bg-canvas">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera preview for scanning the event QR code"
          className="h-full w-full object-cover"
        />

        {status !== "active" ? (
          <div className="absolute inset-0 grid place-items-center text-center">
            <div className="space-y-3 text-muted">
              <QrIcon size={58} className="mx-auto text-accent" />
              <p className="text-sm">
                {status === "starting" ? "Starting the camera…" : "Your camera opens only here."}
              </p>
            </div>
          </div>
        ) : null}

        <div aria-hidden="true" className="pointer-events-none absolute inset-[15%]">
          <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-xl border-l-3 border-t-3 border-accent" />
          <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-xl border-r-3 border-t-3 border-accent" />
          <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-xl border-b-3 border-l-3 border-accent" />
          <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-xl border-b-3 border-r-3 border-accent" />
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {message ? (
        <Callout tone={status === "error" ? "danger" : "warning"} live="polite">
          {message}
        </Callout>
      ) : null}

      {status === "active" ? (
        <Button variant="secondary" size="lg" fullWidth onClick={stopCamera}>
          Turn camera off
        </Button>
      ) : (
        <Button
          size="lg"
          fullWidth
          loading={status === "starting"}
          onClick={() => void startCamera()}
        >
          {status === "error" ? "Try the camera again" : "Start QR scanner"}
        </Button>
      )}

      <Button variant="secondary" size="lg" fullWidth onClick={chooseCode}>
        Enter the six-digit code instead
      </Button>

      <p className="text-center text-xs leading-relaxed text-faint">
        Camera frames stay on this device and are never uploaded.
      </p>
    </div>
  );
}
