import type { Metadata } from "next";

import { ActiveEventSlideshow } from "@/components/slideshow/slideshow-screen";

export const metadata: Metadata = { title: "Slideshow" };

/**
 * PLAN.md → "Slideshow: fullscreen, live-updating, photos + muted autoplay
 * video, pause/skip, chronological or shuffle, configurable photo timing".
 *
 * No `PageHeader` and no card: this route *is* the show. It renders a fixed,
 * full-viewport black stage over the organiser shell — the nav stays mounted
 * underneath, which is what makes leaving the slideshow a single tap when the
 * machine turns out to be a laptop somebody needs back.
 */
export default function SlideshowPage() {
  return <ActiveEventSlideshow />;
}
