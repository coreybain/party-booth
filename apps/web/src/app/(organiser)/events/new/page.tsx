import type { Metadata } from "next";

import { CreateEvent } from "@/components/events/create-event";
import { PageHeader } from "@/components/layout/app-shell";
import { serverNow } from "@/lib/server-now";

export const metadata: Metadata = { title: "New event" };

/**
 * Create an event.
 *
 * PLAN.md → "event creation (name, schedule/timezone, cover, accent,
 * moderation mode)". Cover is the one deferred field: it needs the private
 * upload pipeline that lands in Sprint 3, and the form says so rather than
 * offering a control that cannot finish.
 */
export default function NewEventPage() {
  return (
    <>
      <PageHeader
        title="New event"
        description="Two minutes now, and you have a QR code you can print tonight."
      />
      <CreateEvent nowMs={serverNow()} />
    </>
  );
}
