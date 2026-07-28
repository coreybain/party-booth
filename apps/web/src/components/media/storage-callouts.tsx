"use client";

import { useQuery } from "convex/react";

import { Callout } from "@/components/ui/callout";
import { backendApi } from "@/lib/convex-api";

/**
 * The two configuration failures that look exactly like "the app is broken".
 *
 * Lifted out of Sprint 3's media list when the moderation grid replaced it,
 * because the diagnosis is the valuable part and it belongs wherever a host is
 * looking when nothing arrives:
 *
 * - **No `UPLOADTHING_TOKEN`** — nothing can be stored at all, and no thumbnail
 *   will ever load. Everything else on the page is real, which is what makes
 *   this confusing without the sentence.
 * - **No `UPLOAD_CALLBACK_SECRET`** — files reach storage and the completion
 *   callback is refused, so every capture sticks in `processing` for ever. The
 *   symptom is "photos say uploading and never finish", and the cause is one
 *   value that has to be identical in Vercel and in the Convex dashboard.
 *
 * `media.storageStatus` is host-only and never contains a token.
 */
export function StorageCallouts({
  eventId,
  processing,
}: {
  readonly eventId: string;
  /** How many items are mid-upload right now, for the reassuring version. */
  readonly processing: number;
}) {
  const storage = useQuery(backendApi.media.storageStatus, { eventId });

  if (storage === undefined) return null;

  if (!storage.configured) {
    return (
      <Callout tone="warning" title="Storage is not configured">
        <span className="font-mono">UPLOADTHING_TOKEN</span> is not set for this deployment, so
        nothing can be stored and no thumbnails will load. Everything else on this page is real.
      </Callout>
    );
  }

  if (!storage.callbackConfigured) {
    return (
      <Callout tone="warning" title="Uploads cannot complete">
        <span className="font-mono">UPLOAD_CALLBACK_SECRET</span> is not set, so files reach storage
        and never leave <span className="font-mono">processing</span>. Set the same value in Vercel
        and in the Convex dashboard.
      </Callout>
    );
  }

  if (processing > 0) {
    return (
      <Callout tone="info" live="polite">
        {processing === 1
          ? "One upload is still arriving."
          : `${String(processing)} uploads are still arriving.`}
      </Callout>
    );
  }

  return null;
}
