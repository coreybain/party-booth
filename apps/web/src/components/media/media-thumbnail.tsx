"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

export interface MediaThumbnailProps {
  readonly url: string | undefined;
  readonly alt: string;
  readonly className?: string;
  /** Shown when there is no URL yet, or the one we had did not load. */
  readonly placeholder?: string;
}

/**
 * Keep width ownership in one place.
 *
 * `cn` intentionally does not merge conflicting Tailwind utilities. Baking
 * `w-full` into the base styles made a caller's compact `w-20` lose to CSS
 * stylesheet order, so the thumbnail filled the row and crushed its metadata.
 */
export function thumbnailBoxClassName(className: string | undefined): string {
  return cn(
    "relative aspect-square shrink-0 overflow-hidden rounded-xl",
    "border border-line bg-raised",
    className ?? "w-20",
  );
}

/**
 * A square thumbnail for one media item.
 *
 * ## Why a plain `<img>` and not `next/image`
 *
 * Every URL this renders is a **short-lived signed URL for a private object**
 * (ADR 0004 §5). Routing those through `/_next/image` would fetch each one
 * server-side and cache the decoded result on Vercel's shared CDN, keyed on the
 * source URL — which turns a permission-checked, ten-minute read into a
 * cached copy of a guest's photograph sitting on an edge node long after the
 * signature expired, reachable by anyone who has the optimizer URL. The whole
 * point of the private ACL is that there is no such thing as "the URL of a
 * photo"; an image CDN's job is to create exactly that.
 *
 * `unoptimized` on `next/image` would avoid the cache but keeps the layout and
 * `remotePatterns` plumbing for no benefit, and `remotePatterns` would have to
 * name the storage host — which changes per region under ADR 0002.
 *
 * So: a plain element, explicit dimensions from the CSS box (no CLS), lazy
 * loading, and `referrerPolicy="no-referrer"` so the storage host never learns
 * which party page a request came from.
 */
export function MediaThumbnail({ url, alt, className, placeholder = "…" }: MediaThumbnailProps) {
  const [broken, setBroken] = useState(false);
  const usable = url !== undefined && !broken;

  return (
    <div className={thumbnailBoxClassName(className)}>
      {usable ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed private URLs must not be proxied or cached by the image optimizer; see the note above.
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            // A signed URL that expired mid-subscription. A placeholder is a far
            // better answer than a broken-image glyph, and the query re-runs
            // with a fresh URL when anything about the row changes.
            setBroken(true);
          }}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center text-sm text-faint"
        >
          {placeholder}
        </span>
      )}
    </div>
  );
}
