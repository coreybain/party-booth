"use client";

import { usePaginatedQuery } from "convex/react";

import { Placeholder } from "@/components/layout/card";
import { MediaTile } from "@/components/media/media-tile";
import { Button } from "@/components/ui/button";
import { SIGNED_READ_URL_TTL_SECONDS } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { useSignedUrlRefreshKey } from "@/lib/use-signed-url-refresh";

/** Approved, attribution-free media made visible through a finished event's QR. */
export function PastEventGallery({ token }: { readonly token: string }) {
  const urlRefreshKey = useSignedUrlRefreshKey(SIGNED_READ_URL_TTL_SECONDS);
  const { results, status, loadMore } = usePaginatedQuery(
    backendApi.media.publicEventMedia,
    { token, urlRefreshKey },
    { initialNumItems: 24 },
  );

  const firstLoad = status === "LoadingFirstPage";
  const loadingMore = status === "LoadingMore";

  return (
    <section aria-labelledby="past-gallery-heading" className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          Shared by the host
        </p>
        <h2 id="past-gallery-heading" className="mt-1 text-lg font-semibold text-ink">
          Photos from the party
        </h2>
      </div>

      {firstLoad ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="status">
          <span className="sr-only">Loading event photos…</span>
          {Array.from({ length: 6 }, (_, index) => (
            <span
              // Static loading furniture; the position is the identity.
              key={index}
              className="aspect-square animate-pulse rounded-xl bg-raised"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : results.length === 0 ? (
        <Placeholder title="No approved photos to show">
          The host has opened this gallery, but there are no approved photos or videos in it yet.
        </Placeholder>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {results.map((item) => (
              <li key={item.id}>
                <MediaTile item={item} shape="square" />
              </li>
            ))}
          </ul>

          {status === "CanLoadMore" || loadingMore ? (
            <Button
              type="button"
              variant="secondary"
              fullWidth
              loading={loadingMore}
              disabled={loadingMore}
              onClick={() => {
                loadMore(24);
              }}
            >
              Load more photos
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
