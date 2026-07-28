"use client";

import { type FormEvent, type ReactNode, useCallback, useMemo, useState } from "react";

import { Card, Placeholder, SectionHeading } from "@/components/layout/card";
import { AccentPicker } from "@/components/ui/accent-picker";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { ToggleField } from "@/components/ui/toggle-field";
import { formatTimeZoneLabel, timeZoneOptions } from "@/lib/datetime";
import { useBrowserTimeZone } from "@/lib/use-browser-time-zone";
import { MODERATION_MODE_COPY } from "@/lib/event-view";
import {
  buildCreateEventInput,
  buildUpdateEventInput,
  defaultEventFormValues,
  hasEventChanges,
  type CreateEventInput,
  type EventFormErrors,
  type EventFormValues,
  type UpdateEventInput,
} from "@/lib/event-form";
import type { LaunchModerationMode } from "@/lib/contracts";

/**
 * Create and edit, one form.
 *
 * They differ in three things and nothing else: the submit label, whether
 * `initialState` is offered (an event that exists already has a state, and it
 * is changed from the event home where the consequences are visible), and
 * whether the payload is the whole thing or only the fields that changed. That
 * last one matters for permissions — see `buildUpdateEventInput`.
 *
 * Cover images are a Sprint 3 placeholder: uploads need the grant pipeline, and
 * a cover picker that half works is worse than one that says when it lands.
 */

export type EventFormMode =
  | { readonly kind: "create"; readonly onSubmit: (input: CreateEventInput) => Promise<void> }
  | {
      readonly kind: "edit";
      readonly eventId: string;
      readonly initialValues: EventFormValues;
      readonly onSubmit: (input: UpdateEventInput) => Promise<void>;
    };

export interface EventFormProps {
  readonly mode: EventFormMode;
  readonly submitLabel: string;
  /**
   * "Now", handed down from the Server Component that rendered this.
   *
   * A prop rather than `Date.now()` in the body: a client component's render
   * has to be pure and give the same answer on the server and during
   * hydration, and a clock does neither.
   */
  readonly nowMs: number;
  /** Rendered next to the submit button — usually a cancel link. */
  readonly secondaryAction?: ReactNode;
  readonly disabled?: boolean;
}

export function EventForm({
  mode,
  submitLabel,
  nowMs,
  secondaryAction,
  disabled = false,
}: EventFormProps) {
  /**
   * The blank form is *derived*, not stored, so it can pick the browser's own
   * time zone up the moment hydration makes it knowable — see
   * `useBrowserTimeZone` for why that has to come from `useSyncExternalStore`
   * rather than an effect. `edited` takes over as soon as the host touches
   * anything, which freezes the defaults where they were.
   */
  const zone = useBrowserTimeZone();
  const [edited, setEdited] = useState<EventFormValues | undefined>(
    mode.kind === "edit" ? mode.initialValues : undefined,
  );
  const blank = useMemo(() => defaultEventFormValues(nowMs, zone), [nowMs, zone]);
  const values = edited ?? blank;

  const [errors, setErrors] = useState<EventFormErrors>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const set = useCallback(
    <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) => {
      setEdited((current) => ({ ...(current ?? blank), [key]: value }));
      setErrors((current) => ({ ...current, [key]: undefined }));
      setFailure(undefined);
    },
    [blank],
  );

  /** Run a submit handler, turning a thrown failure into copy under the button. */
  const runSubmit = useCallback(async (send: () => Promise<void>) => {
    setErrors({});
    setPending(true);
    try {
      await send();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That didn't save. Try again.");
    } finally {
      setPending(false);
    }
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFailure(undefined);

      // Branching on `mode` rather than on a merged result keeps each builder
      // paired with the `onSubmit` that takes its output, with no cast.
      if (mode.kind === "create") {
        const built = buildCreateEventInput(values);
        if (!built.ok) {
          setErrors(built.errors);
          return;
        }
        await runSubmit(() => mode.onSubmit(built.input));
        return;
      }

      const built = buildUpdateEventInput(mode.eventId, values, mode.initialValues);
      if (!built.ok) {
        setErrors(built.errors);
        return;
      }
      await runSubmit(() => mode.onSubmit(built.input));
    },
    [mode, runSubmit, values],
  );

  const zones = timeZoneOptions(values.timeZone);
  const nothingToSave =
    mode.kind === "edit" && !hasEventChanges(values, mode.initialValues) && !pending;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <Card>
        <SectionHeading title="The basics" description="What guests see when they scan the QR." />
        <div className="mt-4 space-y-4">
          <TextField
            label="Event name"
            name="event-name"
            value={values.name}
            onChange={(event) => {
              set("name", event.target.value);
            }}
            maxLength={80}
            placeholder="Corey's 40th"
            autoComplete="off"
            enterKeyHint="next"
            error={errors.name}
            disabled={disabled || pending}
            autoFocus={mode.kind === "create"}
          />
          <AccentPicker
            value={values.accentColor}
            onChange={(value) => {
              set("accentColor", value);
            }}
            disabled={disabled || pending}
            {...(errors.accentColor === undefined ? {} : { error: errors.accentColor })}
          />
        </div>
      </Card>

      <Card>
        <SectionHeading
          title="When"
          description="The code and QR work from a month before the start; uploads only while the event is live."
        />
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Starts"
              name="starts-at"
              type="datetime-local"
              value={values.startsAtLocal}
              onChange={(event) => {
                set("startsAtLocal", event.target.value);
              }}
              error={errors.startsAtLocal}
              disabled={disabled || pending}
            />
            <TextField
              label="Ends (optional)"
              name="ends-at"
              type="datetime-local"
              value={values.endsAtLocal}
              onChange={(event) => {
                set("endsAtLocal", event.target.value);
              }}
              hint="Leave empty for an open-ended night."
              error={errors.endsAtLocal}
              disabled={disabled || pending}
            />
          </div>
          <SelectField
            label="Time zone"
            name="time-zone"
            value={values.timeZone}
            onChange={(event) => {
              set("timeZone", event.target.value);
            }}
            options={zones.map((zone) => ({ value: zone, label: formatTimeZoneLabel(zone) }))}
            hint="Times above are read in this zone, for everyone."
            {...(errors.timeZone === undefined ? {} : { error: errors.timeZone })}
            disabled={disabled || pending}
          />
        </div>
      </Card>

      <Card>
        <SectionHeading
          title="Moderation"
          description="You can change this mid-party — switching to publishing straight away is the pressure valve when the queue outruns you."
        />
        <div className="mt-4 space-y-4">
          <ChoiceGroup<LaunchModerationMode>
            legend="What happens to a new photo"
            value={values.moderationMode}
            onChange={(value) => {
              set("moderationMode", value);
            }}
            choices={[
              { value: "manual", ...MODERATION_MODE_COPY.manual },
              { value: "automatic", ...MODERATION_MODE_COPY.automatic },
            ]}
            disabled={disabled || pending}
            {...(errors.moderationMode === undefined ? {} : { error: errors.moderationMode })}
          />
          <ToggleField
            label="Let guests pick existing photos"
            description="Off means the camera only — nothing from the camera roll."
            checked={values.allowLibraryImport}
            onChange={(checked) => {
              set("allowLibraryImport", checked);
            }}
            disabled={disabled || pending}
          />
        </div>
      </Card>

      {mode.kind === "create" ? (
        <Card>
          <SectionHeading
            title="Open the doors?"
            description="A scheduled event's code and QR already work, so you can print the sign before the day."
          />
          <ChoiceGroup<"draft" | "scheduled">
            className="mt-4"
            legend="Starting state"
            value={values.initialState}
            onChange={(value) => {
              set("initialState", value);
            }}
            choices={[
              {
                value: "scheduled",
                label: "Scheduled — guests can join",
                description: "The QR works now. Uploads open when you go live.",
              },
              {
                value: "draft",
                label: "Draft — just me for now",
                description: "Nobody can join until you schedule it.",
              },
            ]}
            disabled={disabled || pending}
          />
        </Card>
      ) : null}

      <Card>
        <SectionHeading title="Cover image" description="Shown behind the event name." />
        <Placeholder className="mt-4" title="Uploads land in Sprint 3" sprint="Sprint 3">
          Cover images use the same private upload pipeline as guest photos, so they arrive with it.
        </Placeholder>
      </Card>

      {failure === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {failure}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" loading={pending} disabled={disabled || nothingToSave}>
          {submitLabel}
        </Button>
        {secondaryAction}
      </div>
    </form>
  );
}
