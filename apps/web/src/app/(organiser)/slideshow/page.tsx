import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/app-shell";
import { Card, Placeholder } from "@/components/layout/card";

export const metadata: Metadata = { title: "Slideshow" };

/** PLAN.md → "Slideshow: fullscreen, live-updating, photos + muted autoplay video". */
export default function SlideshowPage() {
  return (
    <>
      <PageHeader
        title="Slideshow"
        description="Fullscreen, live-updating, for the TV in the corner of the room."
      />
      <Card>
        <Placeholder title="Nothing approved to show yet" sprint="Sprint 4">
          The slideshow plays approved photos and muted video, updating live, with pause, skip and a
          chronological or shuffled order.
        </Placeholder>
      </Card>
    </>
  );
}
