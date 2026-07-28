import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { ActiveEventMedia } from "@/components/media/event-media-list";

export const metadata: Metadata = { title: "Media" };

/**
 * PLAN.md → "Moderation: masonry grid, approve/decline, filters, bulk select".
 *
 * Sprint 3 lands the **read path** only: a live list of what guests have sent,
 * with statuses and thumbnails from short-lived signed URLs. That is RC3's
 * evidence — a photo taken on a phone shows up here as `pending` within seconds.
 * The grid and the decisions are Sprint 4.
 */
export default function MediaPage() {
  return (
    <>
      <PageHeader
        title="Media"
        description="Everything guests have submitted, and what you've done with it."
      />
      <ActiveEventMedia />
    </>
  );
}
