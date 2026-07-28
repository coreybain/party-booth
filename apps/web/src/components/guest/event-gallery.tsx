"use client";

import { useQuery } from "convex/react";

import { Placeholder } from "@/components/layout/card";
import { MediaTile } from "@/components/media/media-tile";
import { backendApi } from "@/lib/convex-api";

/**
 * The approved gallery, as a guest sees it.
 *
 * TODO.md Sprint 4 → "Approved event gallery (app + web), live via Convex
 * subscriptions". It is `media.eventMedia` narrowed to `approved`, and every
 * decision about what a guest may see was made in Convex before this component
 * existed:
 *
 * - `canSeeMedia` decides which rows come back at all;
 * - `mayServeOriginal` decides whether each row carries a full-resolution URL or
 *   only its derivative — a fellow guest gets the original of a photo (both
 *   first-party clients re-encode, so the claim is recorded and true) and the
 *   **poster** of a video, because no browser can re-encode a clip and an
 *   unverified original is not served to third parties;
 * - the blocklist is applied there too, so somebody a guest has blocked simply
 *   is not in the array.
 *
 * There is therefore nothing in this file that decides visibility, and that is
 * on purpose: a second opinion about privacy is a second place to be wrong.
 */

export function EventGallery({ eventId }: { readonly eventId: string }) {
  const media = useQuery(backendApi.media.eventMedia, {
    eventId,
    states: ["approved"],
    limit: 200,
  });

  return (
    <section aria-labelledby="gallery-heading" className="space-y-3">
      <h2 id="gallery-heading" className="text-base font-semibold text-ink">
        The party so far
      </h2>

      {media === undefined ? (
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      ) : media.length === 0 ? (
        <Placeholder title="Nothing here yet">
          Photos appear once the host has approved them. Yours are in “Your uploads” below until
          then.
        </Placeholder>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {media.map((item) => (
            <li key={item.id}>
              <MediaTile item={item} shape="square" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
