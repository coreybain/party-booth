"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { EventSettingsPanel } from "@/components/events/event-settings-sheet";
import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type EventHome, type EventSummary } from "@/lib/convex-api";

export function eventRoleLabel(role: EventSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Host";
    case "cohost":
      return "Co-host";
    default:
      return "Guest";
  }
}

export function GuestEventSettings({ home }: { readonly home: EventHome }) {
  const { event, invite, isHost } = home;
  const eventId = event.id;
  const router = useRouter();
  const me = useQuery(backendApi.users.currentUser, {});
  const events = useQuery(backendApi.events.myEvents, {});
  const setActiveEvent = useMutation(backendApi.events.setActiveEvent);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const switchEvent = useCallback(
    async (nextEventId: string) => {
      if (nextEventId === eventId || switchingTo !== null) return;
      setSwitchingTo(nextEventId);
      setError(null);
      try {
        await setActiveEvent({ eventId: nextEventId });
        router.replace(`/event/${nextEventId}`);
      } catch (caught) {
        setError(appErrorMessage(caught));
        setSwitchingTo(null);
      }
    },
    [eventId, router, setActiveEvent, switchingTo],
  );

  return (
    <div className="space-y-5">
      {me === undefined ? (
        <div className="h-20 animate-pulse rounded-xl bg-raised" role="status">
          <span className="sr-only">Loading your account…</span>
        </div>
      ) : me === null ? null : (
        <section className="flex items-center gap-3 rounded-xl border border-line bg-raised/60 p-3">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-full border border-accent/35 bg-accent-soft text-sm font-semibold text-accent"
            aria-hidden="true"
          >
            {initials(me.displayName)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">{me.displayName}</h2>
            <p className="truncate text-xs text-muted">{me.email}</p>
          </div>
        </section>
      )}

      {isHost ? (
        <section aria-labelledby="host-settings-heading" className="space-y-3">
          <div>
            <h2
              id="host-settings-heading"
              className="text-xs font-semibold uppercase tracking-widest text-faint"
            >
              Host settings
            </h2>
            <p className="mt-1 text-sm text-muted">
              Manage how guests join, how photos are accepted, and who can help host.
            </p>
          </div>

          <EventSettingsPanel event={event} invite={invite} collapsible />
        </section>
      ) : (
        <Callout tone="info">
          You’re attending {event.name} as a guest, so this event’s host settings are not available
          to this account. Ask the owner to add {me?.email ?? "this account"} as a co-host, or
          switch to an event you host below.
        </Callout>
      )}

      <section aria-label="Your events" className="space-y-3">
        {error ? (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        ) : null}

        {events === undefined ? (
          <p className="text-sm text-muted" role="status">
            Finding your events…
          </p>
        ) : events.length === 0 ? null : events.length === 1 ? (
          <div className="rounded-xl border border-line bg-raised/60 px-4 py-3">
            <p className="text-sm font-medium text-ink">{events[0]?.name}</p>
            <p className="mt-0.5 text-xs text-muted">
              Current event · {events[0] === undefined ? "Guest" : eventRoleLabel(events[0].role)}
            </p>
          </div>
        ) : (
          <label className="block text-sm font-medium text-ink">
            Active event
            <select
              value={eventId}
              disabled={switchingTo !== null}
              aria-busy={switchingTo !== null || undefined}
              onChange={(changeEvent) => {
                void switchEvent(changeEvent.target.value);
              }}
              className="mt-2 h-12 w-full rounded-xl border border-line bg-raised px-3 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
            >
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name} — {eventRoleLabel(event.role)}
                </option>
              ))}
            </select>
          </label>
        )}

        <Button variant="secondary" size="lg" fullWidth onClick={() => router.push("/join")}>
          Join another event
        </Button>
      </section>

      <section aria-labelledby="legal-heading" className="space-y-3 border-t border-line pt-5">
        <h2
          id="legal-heading"
          className="text-xs font-semibold uppercase tracking-widest text-faint"
        >
          Privacy & account
        </h2>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <Link href="/privacy" className="text-muted underline underline-offset-4 hover:text-ink">
            Privacy policy
          </Link>
          <Link href="/terms" className="text-muted underline underline-offset-4 hover:text-ink">
            Terms of use
          </Link>
          <SignOutButton redirectTo="/join" />
        </div>
      </section>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "?"}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}
