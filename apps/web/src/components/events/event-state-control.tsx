"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { EventSettingsSheet } from "@/components/events/event-settings-sheet";
import { CalendarIcon, MediaIcon, MoreVerticalIcon, SettingsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type EventHome, type EventSummary } from "@/lib/convex-api";
import { isEditableEventState, type HostSettableEventState } from "@/lib/contracts";
import {
  allowedNextStates,
  END_EVENT_CONFIRMATION_SECONDS,
  eventHasEnded,
  eventNowAction,
  liveEventTiming,
  type LiveEventTiming,
  tickEndEventConfirmation,
} from "@/lib/event-view";

type PendingAction = HostSettableEventState | "startNow" | "endNow" | "delete" | "publicGallery";
type Confirmation = "archive" | "delete";

const LIVE_BADGE_STYLES: Readonly<
  Record<
    LiveEventTiming,
    { className: string; dotClassName: string; label: string; ariaLabel: string }
  >
> = {
  future: {
    className: "border-info/40 bg-info-soft text-info",
    dotClassName: "bg-info",
    label: "Live future event",
    ariaLabel: "Event is live and starts in the future",
  },
  normal: {
    className: "border-positive/40 bg-positive/10 text-positive",
    dotClassName: "bg-positive",
    label: "Live event",
    ariaLabel: "Event is live",
  },
  soon: {
    className: "border-warning/40 bg-warning/10 text-warning",
    dotClassName: "bg-warning",
    label: "Ends within 2h",
    ariaLabel: "Event is live and ends within two hours",
  },
  imminent: {
    className: "border-danger/40 bg-danger/10 text-danger",
    dotClassName: "bg-danger",
    label: "Ends within 30m",
    ariaLabel: "Event is live and ends within thirty minutes",
  },
};

/**
 * The compact lifecycle control shown beside the event title.
 *
 * The product language deliberately collapses the state machine into the three
 * answers a host needs in the moment: the event has ended, is live, or can be
 * published. The backend still owns the detailed states:
 *
 * - Publish moves any legal non-live state to `live` without rewriting dates.
 * - Start now rewrites the start time and moves the event to `live` atomically.
 * - End now arms a short inline confirmation, then rewrites the end time and
 *   moves `live` to `paused`; doing nothing disarms it automatically.
 * - Unpublish moves `live` to `paused`, keeping the gallery and memberships.
 * - Archive remains the explicit end-of-event transition.
 * - Delete enters the scheduled-deletion lifecycle rather than silently
 *   destroying guests' submissions from a menu click.
 *
 * Radix owns menu focus, arrow-key navigation and Escape handling. Archive and
 * Delete open confirmations because both remove access for other people.
 */
export function EventStateControl({
  event,
  invite,
  isOwner,
  nowMs,
}: {
  readonly event: EventSummary;
  readonly invite?: EventHome["invite"];
  readonly isOwner: boolean;
  readonly nowMs: number;
}) {
  const { id: eventId, state } = event;
  const router = useRouter();
  const setState = useMutation(backendApi.events.setState);
  const setNow = useMutation(backendApi.events.setNow);
  const requestDeletion = useMutation(backendApi.events.requestDeletion);
  const setPublicGallery = useMutation(backendApi.events.setPublicGallery);
  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [confirming, setConfirming] = useState<Confirmation | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reissuedCode, setReissuedCode] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endConfirmation, setEndConfirmation] = useState<number | undefined>(undefined);
  const [clockMs, setClockMs] = useState(nowMs);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockMs(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (endConfirmation === undefined) return;

    const timeout = window.setTimeout(() => {
      setEndConfirmation(tickEndEventConfirmation);
    }, 1_000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [endConfirmation]);

  const applyState = useCallback(
    async (next: HostSettableEventState) => {
      setPending(next);
      setError(undefined);
      try {
        const result = await setState({ eventId, state: next });
        setReissuedCode(result.reissuedCode);
        setConfirming(undefined);
        setEndConfirmation(undefined);
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(undefined);
      }
    },
    [eventId, setState],
  );

  const applyNow = useCallback(
    async (action: "start" | "end") => {
      setPending(action === "start" ? "startNow" : "endNow");
      setError(undefined);
      try {
        const result = await setNow({ eventId, action });
        setReissuedCode(result.reissuedCode);
        setEndConfirmation(undefined);
        setClockMs(Date.now());
        // The page's clock is server-rendered to avoid hydration drift. Refresh
        // it with the freshly-stamped schedule so "Past event"/"Live" updates
        // immediately instead of waiting for the next navigation.
        router.refresh();
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(undefined);
      }
    },
    [eventId, router, setNow],
  );

  const deleteEvent = useCallback(async () => {
    setPending("delete");
    setError(undefined);
    try {
      await requestDeletion({ eventId });
      router.replace("/dashboard");
    } catch (caught) {
      setError(appErrorMessage(caught));
      setPending(undefined);
    }
  }, [eventId, requestDeletion, router]);

  const togglePublicGallery = useCallback(async () => {
    const next = !event.publicGalleryEnabled;
    setPending("publicGallery");
    setError(undefined);
    try {
      await setPublicGallery({ eventId, enabled: next });
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(undefined);
    }
  }, [event.publicGalleryEnabled, eventId, setPublicGallery]);

  const live = state === "live";
  const past = eventHasEnded(event, clockMs);
  const canPublish = !past && state !== "live" && state !== "deletionScheduled";
  const canEdit = isEditableEventState(state);
  const immediateAction = eventNowAction(event, clockMs);
  const canStartNow = immediateAction === "start";
  const canEndNow = immediateAction === "end";
  const canArchive = isOwner && allowedNextStates(state).includes("archived");
  const canDelete = isOwner && state !== "deletionScheduled";
  const canOpenSettings = state !== "deletionScheduled";
  const hasImmediateAction = canStartNow || canEndNow;
  const hasMenu =
    hasImmediateAction || canOpenSettings || live || canEdit || canArchive || canDelete;
  const liveTiming = liveEventTiming(event, clockMs) ?? "normal";
  const liveBadge = LIVE_BADGE_STYLES[liveTiming];
  const liveStatus = (
    <span
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium ${liveBadge.className}`}
      role="status"
      aria-label={liveBadge.ariaLabel}
    >
      <span className="relative flex size-2.5" aria-hidden="true">
        <span
          className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${liveBadge.dotClassName}`}
        />
        <span className={`relative inline-flex size-2.5 rounded-full ${liveBadge.dotClassName}`} />
      </span>
      {liveBadge.label}
    </span>
  );

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {past ? (
            <>
              <span
                className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-raised px-3 text-sm font-medium text-muted"
                role="status"
                aria-label="Event has ended"
              >
                <CalendarIcon size={16} />
                Past event
              </span>
              {isOwner ? (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-pressed={event.publicGalleryEnabled}
                  loading={pending === "publicGallery"}
                  disabled={pending !== undefined}
                  onClick={() => {
                    void togglePublicGallery();
                  }}
                >
                  <MediaIcon size={16} />
                  {event.publicGalleryEnabled ? "Photos public" : "Photos private"}
                </Button>
              ) : null}
            </>
          ) : live ? (
            liveStatus
          ) : canPublish ? (
            <Button
              size="sm"
              loading={pending === "live"}
              disabled={pending !== undefined}
              onClick={() => {
                void applyState("live");
              }}
            >
              Publish
            </Button>
          ) : null}

          {hasMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className="size-10 rounded-full px-0"
                  disabled={pending !== undefined}
                  aria-label="Event actions"
                  title="Event actions"
                >
                  <MoreVerticalIcon size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canStartNow ? (
                  <DropdownMenuItem
                    disabled={pending !== undefined}
                    onSelect={() => {
                      void applyNow("start");
                    }}
                  >
                    Start now
                  </DropdownMenuItem>
                ) : null}
                {canEndNow ? (
                  <DropdownMenuItem
                    tone={endConfirmation === undefined ? "default" : "danger"}
                    disabled={pending !== undefined}
                    aria-label={
                      endConfirmation === undefined
                        ? "End now"
                        : `Confirm end now, ${String(endConfirmation)} seconds remaining`
                    }
                    onSelect={(selectEvent) => {
                      if (endConfirmation === undefined) {
                        selectEvent.preventDefault();
                        setError(undefined);
                        setEndConfirmation(END_EVENT_CONFIRMATION_SECONDS);
                        return;
                      }

                      setEndConfirmation(undefined);
                      void applyNow("end");
                    }}
                  >
                    {endConfirmation === undefined ? (
                      "End now"
                    ) : (
                      <span aria-live="polite">
                        Confirm end now · <span className="tabular-nums">{endConfirmation}s</span>
                      </span>
                    )}
                  </DropdownMenuItem>
                ) : null}
                {hasImmediateAction ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  onSelect={() => {
                    router.push(`/event/${encodeURIComponent(eventId)}`);
                  }}
                >
                  <MediaIcon size={16} className="mr-2 text-muted" />
                  View as guest
                </DropdownMenuItem>
                {canOpenSettings ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setSettingsOpen(true);
                    }}
                  >
                    <SettingsIcon size={16} className="mr-2 text-muted" />
                    Settings
                  </DropdownMenuItem>
                ) : null}
                {live ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      void applyState("paused");
                    }}
                  >
                    Unpublish
                  </DropdownMenuItem>
                ) : null}
                {canEdit ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      router.push(`/events/${eventId}/edit`);
                    }}
                  >
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {(live || canEdit) && (canArchive || canDelete) ? <DropdownMenuSeparator /> : null}
                {canArchive ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setError(undefined);
                      setConfirming("archive");
                    }}
                  >
                    Archive
                  </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem
                    tone="danger"
                    onSelect={() => {
                      setError(undefined);
                      setConfirming("delete");
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {reissuedCode === undefined ? null : (
          <p className="max-w-64 text-right text-xs leading-5 text-warning" role="status">
            This event needed a new join code: {reissuedCode}
          </p>
        )}

        {error === undefined || confirming !== undefined ? null : (
          <p className="max-w-64 text-right text-xs leading-5 text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      <EventSettingsSheet
        event={event}
        invite={invite}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <Dialog
        open={confirming === "archive"}
        onOpenChange={(open) => {
          if (!open && pending === undefined) {
            setConfirming(undefined);
            setError(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this event?</DialogTitle>
            <DialogDescription>
              The gallery and slideshow stay available, but nobody new can join and the current
              six-digit code becomes available for another event.
            </DialogDescription>
          </DialogHeader>
          {error === undefined ? null : (
            <Callout tone="danger" live="assertive" className="mt-4">
              {error}
            </Callout>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending !== undefined}
              onClick={() => {
                setConfirming(undefined);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending === "archived"}
              disabled={pending !== undefined && pending !== "archived"}
              onClick={() => {
                void applyState("archived");
              }}
            >
              Archive event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming === "delete"}
        onOpenChange={(open) => {
          if (!open && pending === undefined) {
            setConfirming(undefined);
            setError(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this event?</DialogTitle>
            <DialogDescription>
              It disappears from every host and guest immediately. The event and its submissions are
              queued for permanent deletion after the recovery window.
            </DialogDescription>
          </DialogHeader>
          {error === undefined ? null : (
            <Callout tone="danger" live="assertive" className="mt-4">
              {error}
            </Callout>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending !== undefined}
              onClick={() => {
                setConfirming(undefined);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending === "delete"}
              disabled={pending !== undefined && pending !== "delete"}
              onClick={() => {
                void deleteEvent();
              }}
            >
              Delete event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
