import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { ActiveEventModeration } from "@/components/moderation/moderation-board";

export const metadata: Metadata = { title: "Moderation" };

/**
 * PLAN.md → "Moderation: masonry grid, approve/decline, filters, bulk select".
 *
 * Sprint 3 put the read path here — proof that a photo taken on a phone reaches
 * the host in seconds. Sprint 4 makes it the screen the host actually works
 * from: filters, selection, bulk decisions, keyboard review, and reported items
 * pulled to the top. The list is still `media.eventMedia` and the visibility
 * rules are still `canSeeMedia`'s, applied in Convex; everything added here is
 * about what a host does with what they are already allowed to see.
 */
export default function ModerationPage() {
  return (
    <>
      <PageHeader
        title="Moderation"
        description="Approve what goes on the wall. Arrows move, A approves, D declines."
      />
      <ActiveEventModeration />
    </>
  );
}
