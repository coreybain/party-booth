"use client";

import { useQuery } from "convex/react";

import { BackendGate } from "@/components/backend-gate";
import { Card, Placeholder, SectionHeading } from "@/components/layout/card";
import { MediaThumbnail } from "@/components/media/media-thumbnail";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/status-chip";
import { backendApi, type MediaItem } from "@/lib/convex-api";
import { formatBytes, MODERATION_STATE_COPY } from "@/lib/media-view";
import { formatRelative } from "@/lib/datetime";
import { useNow } from "@/lib/use-now";

/**
 * The organiser's media list — Sprint 3's proof that the read path works.
 *
 * Deliberately **not** the moderation UI. PLAN.md puts the masonry grid,
 * approve/decline, filters and bulk select in Sprint 4; what this has to
 * demonstrate for RC3 is narrower and more important: that a photo taken on a
 * phone appears here within seconds, in the right state, with a thumbnail that
 * renders — which is to say that grants, callbacks, media rows, permission
 * checks and **short-lived signed URLs** all work end to end.
 *
 * Three things it shows on purpose:
 *
 * - **Every state a host may see**, `processing` included. A photo that arrives
 *   and sticks in `processing` is the exact failure mode of a missing
 *   `UPLOAD_CALLBACK_SECRET`, and hiding it would hide the diagnosis.
 * - **A missing URL as a missing URL.** `MediaItem.url` is absent while an item
 *   is processing *and* when the deployment has no storage credentials. A
 *   placeholder next to a correct status chip is a far better failure than a
 *   thrown query.
 * - **Nothing that is not permitted.** The filtering is `canSeeMedia`'s, applied
 *   in Convex; this component renders whatever the query returned and makes no
 *   visibility decision of its own. There is nothing here to get wrong because
 *   there is nothing here to decide.
 */

export interface EventMediaListProps {
  readonly eventId: string;
}

export function EventMediaList({ eventId }: EventMediaListProps) {
  return (
    <BackendGate>
      <EventMediaListLive eventId={eventId} />
    </BackendGate>
  );
}

function EventMediaListLive({ eventId }: EventMediaListProps) {
  const media = useQuery(backendApi.media.eventMedia, { eventId });
  const storage = useQuery(backendApi.media.storageStatus, { eventId });
  // One clock for the whole grid, ticking on a timer rather than read during
  // render — so every "2 minutes ago" on the page agrees with every other one,
  // and none of them is a hydration mismatch.
  const now = useNow();

  if (media === undefined) {
    return (
      <Card>
        <p className="text-sm text-muted" role="status">
          Loading submissions…
        </p>
      </Card>
    );
  }

  const processing = media.filter((item) => item.state === "processing").length;

  return (
    <div className="space-y-4">
      {storage !== undefined && !storage.configured ? (
        <Callout tone="warning" title="Storage is not configured">
          `UPLOADTHING_TOKEN` is not set for this deployment, so nothing can be stored and no
          thumbnails will load. Everything else on this page is real.
        </Callout>
      ) : null}

      {storage !== undefined && storage.configured && !storage.callbackConfigured ? (
        <Callout tone="warning" title="Uploads cannot complete">
          `UPLOAD_CALLBACK_SECRET` is not set, so files reach storage and never leave
          <span className="font-mono"> processing</span>. Set the same value in Vercel and in the
          Convex dashboard.
        </Callout>
      ) : null}

      {processing > 0 && storage?.callbackConfigured === true ? (
        <Callout tone="info" live="polite">
          {processing === 1
            ? "One photo is still arriving."
            : `${String(processing)} photos are still arriving.`}
        </Callout>
      ) : null}

      <Card>
        <SectionHeading
          title="Submissions"
          description="Live — new photos appear here as guests send them."
        />

        {media.length === 0 ? (
          <Placeholder title="Nothing yet" sprint="Sprint 4" className="mt-5">
            Guests who have joined can add photos as soon as the event is live. Approving, declining
            and filtering land here next.
          </Placeholder>
        ) : (
          <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {media.map((item) => (
              <li key={item.id}>
                <MediaCard item={item} now={now} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function MediaCard({ item, now }: { readonly item: MediaItem; readonly now: number }) {
  const copy = MODERATION_STATE_COPY[item.state];

  return (
    <figure className="space-y-2">
      <MediaThumbnail
        url={item.previewUrl ?? item.url}
        alt={`Photo from ${item.uploaderDisplayName}`}
      />
      <figcaption className="space-y-1">
        <StatusChip label={copy.label} tone={copy.tone} />
        <p className="truncate text-xs text-muted" title={item.uploaderDisplayName}>
          {item.uploaderDisplayName}
        </p>
        <p className="text-xs text-faint">
          {formatRelative(item.uploadedAt ?? item.createdAt, now)} · {formatBytes(item.byteSize)}
        </p>
      </figcaption>
    </figure>
  );
}

/**
 * The `/media` page's entry point: whichever event the header switcher is
 * pointing at.
 *
 * `/media` has no event in its URL — the switcher writes `users.activeEventId`
 * and every unscoped organiser page follows it, which is also what points the
 * Expo app's host tab at the same party. Resolving it here rather than in the
 * page keeps the page a Server Component with metadata and nothing else.
 */
export function ActiveEventMedia() {
  return (
    <BackendGate>
      <ActiveEventMediaLive />
    </BackendGate>
  );
}

function ActiveEventMediaLive() {
  const active = useQuery(backendApi.events.activeEvent, {});

  if (active === undefined) {
    return (
      <Card>
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      </Card>
    );
  }

  if (active === null) {
    return (
      <Card>
        <Placeholder title="No event selected">
          Pick an event from the switcher at the top, or create one — submissions are always shown
          for one party at a time.
        </Placeholder>
      </Card>
    );
  }

  return <EventMediaListLive eventId={active.id} />;
}
