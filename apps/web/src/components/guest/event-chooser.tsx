"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { StateBadge } from "@/components/events/state-badge";
import { ArrowRightIcon, HomeIcon } from "@/components/icons";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type EventSummary } from "@/lib/convex-api";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";

export function eventChoiceRoleLabel(role: EventSummary["role"]): "Host" | "Co-host" | null {
  if (role === "owner") return "Host";
  if (role === "cohost") return "Co-host";
  return null;
}

/** The explicit event-or-dashboard choice shown after host sign-in. */
export function EventChooser({ showAdminDashboard }: { readonly showAdminDashboard: boolean }) {
  return (
    <AuthenticatedBackendGate loadingFallback={<EventChooserSkeleton />}>
      <EventChooserLive showAdminDashboard={showAdminDashboard} />
    </AuthenticatedBackendGate>
  );
}

function EventChooserLive({ showAdminDashboard }: { readonly showAdminDashboard: boolean }) {
  const router = useRouter();
  const events = useQuery(backendApi.events.myEvents, {});
  const setActiveEvent = useMutation(backendApi.events.setActiveEvent);
  const [openingEventId, setOpeningEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openEvent = async (eventId: string) => {
    if (openingEventId !== null) return;
    setOpeningEventId(eventId);
    setError(null);
    try {
      await setActiveEvent({ eventId });
      router.push(`/event/${encodeURIComponent(eventId)}`);
    } catch (caught) {
      setError(appErrorMessage(caught));
      setOpeningEventId(null);
    }
  };

  if (events === undefined) return <EventChooserSkeleton />;

  return (
    <div className="space-y-5">
      {error ? (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      ) : null}

      <section aria-labelledby="event-choices-heading">
        <h2
          id="event-choices-heading"
          className="text-xs font-semibold uppercase tracking-widest text-faint"
        >
          Your events
        </h2>

        {events.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-5 text-sm text-muted">
            You don&rsquo;t have an event to open yet. Join one with its code, or use the admin
            dashboard to create an event.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {events.map((event) => {
              const opening = openingEventId === event.id;
              const roleLabel = eventChoiceRoleLabel(event.role);
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    disabled={openingEventId !== null}
                    aria-busy={opening || undefined}
                    onClick={() => void openEvent(event.id)}
                    className="flex w-full items-start gap-3 rounded-xl border border-line bg-raised/60 p-3 text-left transition-colors hover:border-line-strong hover:bg-raised disabled:cursor-wait disabled:opacity-60"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1 h-10 w-1.5 shrink-0 rounded-full bg-accent"
                      style={
                        event.accentColor === undefined
                          ? undefined
                          : { backgroundColor: event.accentColor }
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">
                          {event.name}
                        </span>
                        <StateBadge state={event.state} />
                        {roleLabel === null ? null : (
                          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-faint">
                            {roleLabel}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
                        <span className="text-faint">
                          ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
                        </span>
                      </span>
                    </span>
                    {opening ? (
                      <span className="mt-1 size-4 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                    ) : (
                      <ArrowRightIcon size={18} className="mt-1 shrink-0 text-faint" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showAdminDashboard ? (
        <section aria-labelledby="admin-choice-heading" className="border-t border-line pt-5">
          <h2
            id="admin-choice-heading"
            className="text-xs font-semibold uppercase tracking-widest text-faint"
          >
            Hosting
          </h2>
          <Link
            href="/dashboard"
            className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-raised/60 p-4 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
              <HomeIcon size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">Admin dashboard</span>
              <span className="mt-0.5 block text-xs text-muted">
                Manage events, guests, photos and slideshows.
              </span>
            </span>
            <ArrowRightIcon size={18} className="shrink-0 text-faint" />
          </Link>
        </section>
      ) : null}

      <p className="text-center text-sm text-muted">
        Have another invitation?{" "}
        <Link href="/join" className="text-accent underline underline-offset-2">
          Join with a code
        </Link>
      </p>
    </div>
  );
}

function EventChooserSkeleton() {
  return (
    <div className="space-y-3" role="status">
      <span className="sr-only">Loading your choices…</span>
      {[0, 1, 2].map((key) => (
        <div key={key} className="h-20 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      ))}
    </div>
  );
}
