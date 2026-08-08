"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { CohostPanel } from "@/components/events/cohost-panel";
import { InvitePanel } from "@/components/events/invite-panel";
import { PhotoChallengeSettings } from "@/components/events/photo-challenge-settings";
import { RotationPanel } from "@/components/events/rotation-panel";
import { StateBadge } from "@/components/events/state-badge";
import { ChevronDownIcon, MediaIcon } from "@/components/icons";
import { SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ToggleField } from "@/components/ui/toggle-field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { appErrorMessage } from "@/lib/app-errors";
import { cn } from "@/lib/cn";
import { backendApi, type EventHome, type EventSummary } from "@/lib/convex-api";
import { isEditableEventState, type LaunchModerationMode } from "@/lib/contracts";
import { formatSchedule, timeZoneAbbreviation } from "@/lib/datetime";
import { MODERATION_MODE_COPY } from "@/lib/event-view";

/**
 * Event-specific settings beside the event's lifecycle actions.
 *
 * The event page already has an exact event in hand, so this sheet receives it
 * directly instead of following the global active-event selection. That keeps
 * its schedule, co-host roster and invite code pinned to the title behind it,
 * even if another tab changes the active event while the sheet is open.
 */
export function EventSettingsSheet({
  event,
  invite,
  open,
  onOpenChange,
}: {
  readonly event: EventSummary;
  readonly invite?: EventHome["invite"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl" closeLabel="Close event settings">
        <SheetHeader>
          <SheetTitle>{event.name} settings</SheetTitle>
          <SheetDescription>
            Manage this event’s schedule, moderation, co-hosts and invitation access.
          </SheetDescription>
        </SheetHeader>

        <EventSettingsPanel
          event={event}
          invite={invite}
          className="mt-6"
          onRequestClose={() => {
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

export function EventSettingsPanel({
  event,
  invite,
  onRequestClose,
  className,
  collapsible = false,
}: {
  readonly event: EventSummary;
  readonly invite?: EventHome["invite"];
  readonly onRequestClose?: () => void;
  readonly className?: string;
  readonly collapsible?: boolean;
}) {
  const router = useRouter();
  const me = useQuery(backendApi.users.currentUser, {});
  const editable = isEditableEventState(event.state);

  return (
    <div className={cn("space-y-4", className)}>
      {invite === undefined ? null : (
        <SettingsCard
          title="Join code & QR"
          description="Hold this up so guests can scan it, or give them the six-digit code."
          collapsible={collapsible}
        >
          <div className="mt-4">
            <InvitePanel
              code={invite.code}
              token={invite.token}
              version={invite.version}
              state={event.state}
              eventName={event.name}
            />
          </div>
        </SettingsCard>
      )}

      <SettingsCard
        title="Schedule & moderation"
        description="When guests can join and whether submissions need approval."
        action={<StateBadge state={event.state} />}
        collapsible={collapsible}
      >
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <p className="min-w-0 text-sm text-ink">
            {formatSchedule(event.startsAt, event.endsAt, event.timeZone)}{" "}
            <span className="text-faint">
              ({timeZoneAbbreviation(event.startsAt, event.timeZone)})
            </span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={!editable}
            onClick={() => {
              onRequestClose?.();
              router.push(`/events/${event.id}/edit`);
            }}
          >
            Edit event
          </Button>
        </div>
        <ModerationSetting
          key={`${event.id}:${event.moderationMode}`}
          eventId={event.id}
          initialMode={event.moderationMode === "automatic" ? "automatic" : "manual"}
          disabled={!editable}
        />
      </SettingsCard>

      <SettingsCard
        title="Photo challenges"
        description="Give each guest a rotating idea to inspire their next photo."
        collapsible={collapsible}
      >
        <PhotoChallengeSettings eventId={event.id} />
      </SettingsCard>

      <SettingsCard
        title="Past event gallery"
        description="Choose whether the event QR opens the approved photos after the party."
        action={<MediaIcon size={18} className="text-faint" />}
        collapsible={collapsible}
      >
        <PublicGallerySetting
          key={`${event.id}:${String(event.publicGalleryEnabled)}`}
          eventId={event.id}
          initialEnabled={event.publicGalleryEnabled}
          disabled={event.role !== "owner"}
        />
      </SettingsCard>

      <SettingsCard
        title="Co-hosts"
        description="Invite someone to help moderate and run the slideshow."
        collapsible={collapsible}
      >
        <CohostPanel
          className="mt-4"
          eventId={event.id}
          {...(me?.email === undefined ? {} : { ownEmail: me.email })}
        />
      </SettingsCard>

      <SettingsCard
        title="Invite rotation"
        description="Replace the join code and choose what happens to existing guests."
        collapsible={collapsible}
      >
        {event.state === "live" ? (
          <Callout tone="warning" className="mt-4">
            This event is live. Have the new QR ready before rotating the code on the door.
          </Callout>
        ) : null}
        <RotationPanel
          className="mt-4"
          eventId={event.id}
          eventName={event.name}
          canRotate={editable}
        />
      </SettingsCard>
    </div>
  );
}

function SettingsCard({
  title,
  description,
  action,
  collapsible,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly collapsible: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const titleId = `${contentId}-title`;

  return (
    <section className="rounded-2xl border border-line bg-canvas/35 p-4">
      {collapsible ? (
        <>
          <button
            type="button"
            className="flex w-full items-start gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:hidden"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="min-w-0 flex-1">
              <span
                id={titleId}
                role="heading"
                aria-level={2}
                className="block font-semibold text-ink"
              >
                {title}
              </span>
              <span className={cn("mt-1 block text-sm text-muted", !open && "truncate")}>
                {description}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 pt-0.5">
              {action}
              <ChevronDownIcon
                size={17}
                className={cn("text-faint transition-transform", open && "rotate-180")}
              />
            </span>
          </button>
          <div className="hidden sm:block">
            <SectionHeading title={title} description={description} action={action} />
          </div>
        </>
      ) : (
        <SectionHeading title={title} description={description} action={action} />
      )}

      <div
        id={collapsible ? contentId : undefined}
        className={cn(collapsible && !open && "hidden sm:block")}
      >
        {children}
      </div>
    </section>
  );
}

function PublicGallerySetting({
  eventId,
  initialEnabled,
  disabled,
}: {
  readonly eventId: EventSummary["id"];
  readonly initialEnabled: boolean;
  readonly disabled: boolean;
}) {
  const setPublicGallery = useMutation(backendApi.events.setPublicGallery);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function change(next: boolean) {
    if (disabled || pending) return;
    setEnabled(next);
    setPending(true);
    setError(undefined);
    try {
      await setPublicGallery({ eventId, enabled: next });
    } catch (caught) {
      setEnabled(!next);
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <ToggleField
        label="Let people revisit the photos"
        description="After the end time, anyone with the current QR link can view approved photos and video. Pending and declined submissions stay private."
        checked={enabled}
        onChange={(next) => {
          void change(next);
        }}
        disabled={disabled || pending}
      />
      {disabled ? (
        <p className="text-sm text-muted">Only the event owner can make photos public.</p>
      ) : null}
      {error === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      )}
      {pending ? (
        <p className="text-sm text-muted" role="status">
          Saving gallery access…
        </p>
      ) : null}
    </div>
  );
}

/**
 * The moderation switch hosts need during a party, without making them leave
 * the settings sheet for the full event form. It still uses the same
 * `events.update` mutation as that form, so permissions, auditing and live
 * gallery behaviour have one source of truth.
 */
function ModerationSetting({
  eventId,
  initialMode,
  disabled,
}: {
  readonly eventId: EventSummary["id"];
  readonly initialMode: LaunchModerationMode;
  readonly disabled: boolean;
}) {
  const update = useMutation(backendApi.events.update);
  const [mode, setMode] = useState<LaunchModerationMode>(initialMode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const changed = mode !== initialMode;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || pending || disabled) return;

    setPending(true);
    setError(undefined);
    setSaved(false);
    try {
      await update({ eventId, moderationMode: mode });
      setSaved(true);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="mt-4 space-y-3 border-t border-line pt-4"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <ChoiceGroup<LaunchModerationMode>
        legend="What happens to a new photo"
        value={mode}
        onChange={(value) => {
          setMode(value);
          setError(undefined);
          setSaved(false);
        }}
        choices={[
          { value: "manual", ...MODERATION_MODE_COPY.manual },
          { value: "automatic", ...MODERATION_MODE_COPY.automatic },
        ]}
        disabled={disabled || pending}
      />

      {error === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={pending}
          disabled={disabled || !changed}
        >
          Save moderation
        </Button>
        {saved ? (
          <span className="text-sm text-positive" role="status">
            Moderation saved.
          </span>
        ) : null}
        {disabled ? (
          <span className="text-sm text-muted">Archived events are read-only.</span>
        ) : null}
      </div>
    </form>
  );
}
