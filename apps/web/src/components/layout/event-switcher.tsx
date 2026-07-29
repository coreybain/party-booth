"use client";

import { useMutation, useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { ChevronDownIcon } from "@/components/icons";
import { backendApi } from "@/lib/convex-api";
import { cn } from "@/lib/cn";

export interface EventSwitcherProps {
  readonly className?: string;
}

const NEW_EVENT = "__new__";

/**
 * The header's event switcher.
 *
 * A native `<select>`, which is not a compromise: on the phone a host actually
 * moderates from, the platform picker is a full-height wheel with type-ahead,
 * while a custom menu is a scroll trap inside a sticky header. It is also the
 * only version of this that works with one thumb and with a screen reader
 * without any ARIA of its own.
 *
 * Which event is showing comes from the **URL** when there is one
 * (`/events/[eventId]`), falling back to `activeEvent`. That ordering matters:
 * the URL is what the host is looking at, and letting a stale stored selection
 * win would make the header disagree with the page.
 *
 * Switching also writes `users.activeEventId`, because the Expo app's camera
 * and host tabs follow it — picking an event on the laptop should point the
 * phone at it too.
 */
export function EventSwitcher({ className }: EventSwitcherProps) {
  return (
    <AuthenticatedBackendGate
      fallback={<SwitcherPlaceholder className={className} />}
      loadingFallback={<SwitcherPlaceholder className={className} />}
      signedOutFallback={<SwitcherPlaceholder className={className} />}
    >
      <EventSwitcherLive className={className} />
    </AuthenticatedBackendGate>
  );
}

/** The switcher's exact dimensions, with nothing behind it. */
function SwitcherPlaceholder({ className }: EventSwitcherProps) {
  return (
    <span
      className={cn(switcherShape(className), "border-dashed border-line text-faint")}
      role="status"
      aria-label="No backend configured"
    >
      <span className="truncate">Events…</span>
      <ChevronDownIcon size={16} className="shrink-0" aria-hidden="true" />
    </span>
  );
}

function switcherShape(className?: string): string {
  return cn(
    "flex h-10 min-w-0 max-w-[12rem] items-center gap-2 rounded-full border",
    "bg-surface/60 px-3 text-sm sm:max-w-[16rem]",
    className,
  );
}

function EventSwitcherLive({ className }: EventSwitcherProps) {
  const router = useRouter();
  const params = useParams<{ eventId?: string }>();

  const events = useQuery(backendApi.events.myEvents, {});
  const active = useQuery(backendApi.events.activeEvent, {});
  const setActiveEvent = useMutation(backendApi.events.setActiveEvent);

  const shape = switcherShape(className);

  if (events === undefined) {
    return (
      <span
        className={cn(shape, "border-dashed border-line text-faint")}
        role="status"
        aria-label="Loading your events"
      >
        <span className="truncate">Events…</span>
        <ChevronDownIcon size={16} className="shrink-0" aria-hidden="true" />
      </span>
    );
  }

  if (events.length === 0) {
    return (
      <button
        type="button"
        onClick={() => {
          router.push("/events/new");
        }}
        className={cn(shape, "border-dashed border-line text-muted hover:text-ink")}
      >
        <span className="truncate">Create an event</span>
        <ChevronDownIcon size={16} className="shrink-0" aria-hidden="true" />
      </button>
    );
  }

  const routeEventId = typeof params.eventId === "string" ? params.eventId : undefined;
  const current =
    events.find((event) => event.id === routeEventId)?.id ??
    events.find((event) => event.id === active?.id)?.id ??
    events[0]?.id ??
    "";

  return (
    <div className={cn(shape, "relative border-line text-ink")}>
      <select
        aria-label="Switch event"
        value={current}
        onChange={(changeEvent) => {
          const next = changeEvent.target.value;
          if (next === NEW_EVENT) {
            router.push("/events/new");
            return;
          }
          void setActiveEvent({ eventId: next }).catch(() => {
            // Navigation is the point; the stored selection is a convenience.
          });
          router.push(`/events/${next}`);
        }}
        className="absolute inset-0 w-full cursor-pointer appearance-none bg-transparent pl-3 pr-8 text-sm text-ink"
      >
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.name}
          </option>
        ))}
        <option value={NEW_EVENT}>+ New event…</option>
      </select>
      <ChevronDownIcon
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 shrink-0 text-faint"
      />
    </div>
  );
}
