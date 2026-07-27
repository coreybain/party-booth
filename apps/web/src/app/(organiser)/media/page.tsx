import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder } from "@/components/layout/card";

export const metadata: Metadata = { title: "Media" };

/** PLAN.md → "Moderation: masonry grid, approve/decline, filters, bulk select". */
export default function MediaPage() {
  return (
    <>
      <PageHeader
        title="Media"
        description="Everything guests have submitted, and what you've done with it."
      />
      <Card>
        <Placeholder title="No media yet" sprint="Sprint 3–4">
          A masonry grid with approve and decline, filters by status, type and submitter, and bulk
          selection.
        </Placeholder>
      </Card>
    </>
  );
}
