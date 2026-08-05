"use client";

import { CalendarIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { EVENT_STATE_COPY, guestsCanUpload, uploadAvailabilityDescription } from "@/lib/event-view";
import { useNow } from "@/lib/use-now";
import type { JoinPreview } from "@/lib/convex-api";

/**
 * "Yes, this is the right party."
 *
 * Everything a guest needs to recognise the event before they hand over an
 * email address, and nothing more — no counts, no guest list, no media. The
 * backend's `preview` payload is deliberately that thin, and this component is
 * the reason it can stay that way.
 *
 * The accent colour is applied inline because it comes from the *event*, not
 * the theme: a guest who scans two QR codes at a wedding should see two
 * different colours, and that cannot come from a stylesheet.
 */
export function EventPreviewCard({
  preview,
  className,
}: {
  readonly preview: JoinPreview;
  readonly className?: string;
}) {
  const now = useNow();
  const accent = preview.accentColor;
  const uploadsOpen = preview.kind === "joinable" && guestsCanUpload(preview, now);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-1.5 h-9 w-1.5 shrink-0 rounded-full bg-accent"
          style={accent === undefined ? undefined : { backgroundColor: accent }}
        />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-ink">
            {preview.name}
          </h1>
          <p className="mt-1 text-sm text-muted">Hosted by {preview.hostDisplayName}</p>
        </div>
      </div>

      <p className="flex items-start gap-2 text-sm text-muted">
        <CalendarIcon size={16} className="mt-0.5 shrink-0 text-faint" />
        <span>
          {formatSchedule(preview.startsAt, preview.endsAt, preview.timeZone)}{" "}
          <span className="text-faint">
            ({timeZoneAbbreviation(preview.startsAt, preview.timeZone)})
          </span>
        </span>
      </p>

      {uploadsOpen ? null : (
        <p className="rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm text-muted">
          {preview.kind === "past"
            ? "Past event — new guests and uploads are closed."
            : preview.state === "scheduled"
              ? uploadAvailabilityDescription(preview, now)
              : EVENT_STATE_COPY[preview.state].description}
        </p>
      )}
    </div>
  );
}
