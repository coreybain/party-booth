"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { EventMemberships } from "@/components/admin/event-memberships";
import { RotateCodeFields, useRotateCodeForm } from "@/components/admin/rotate-code-form";
import { AdminSearch, AdminTableShell, EmptyRow } from "@/components/admin/table";
import { StateBadge } from "@/components/events/state-badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/status-chip";
import {
  EVENT_ACTION_COPY,
  eventActionsFor,
  eventStateNote,
  type AdminEventAction,
} from "@/lib/admin/actions";
import { formatBytes } from "@/lib/contracts";
import { adminApi, type AdminEvent } from "@/lib/convex-api";
import { groupJoinCode } from "@/lib/event-view";

/**
 * Events: status, asset counts by state, storage, code rotation and the
 * membership list.
 *
 * The join code is **not** in this list, and that is a backend decision this
 * console honours rather than works around: `admin.events` deliberately omits
 * it, because a list view carrying every live code turns one console session
 * into every party in the product. The rotation dialog asks for one event's code
 * on its own, through `invites.current`, and shows it next to the replacement.
 *
 * No thumbnails. `globalAdmin` has no `media.*` capability, so the asset columns
 * are counts and bytes and there is no image tag on the page.
 */
export function EventsTable() {
  const [search, setSearch] = useState("");
  const events = useQuery(adminApi.events, search.trim().length > 0 ? { search } : {});

  return (
    <AdminTableShell
      title="Events"
      description="Asset counts, storage and the guest list. Counts only — this console never renders a photograph."
      search={
        <AdminSearch
          label="Search events"
          placeholder="Event name"
          value={search}
          onChange={setSearch}
        />
      }
      total={events?.total}
      shown={events?.items.length}
    >
      {events === undefined ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : events.items.length === 0 ? (
        <EmptyRow>{search.trim().length > 0 ? "Nothing matches that." : "No events yet."}</EmptyRow>
      ) : (
        <ul className="divide-y divide-line">
          {events.items.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </AdminTableShell>
  );
}

function EventRow({ event }: { readonly event: AdminEvent }) {
  const [open, setOpen] = useState<AdminEventAction | undefined>(undefined);
  const [showMembers, setShowMembers] = useState(false);
  const note = eventStateNote(event);
  const actions = eventActionsFor(event.state);

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{event.name}</span>
            <StateBadge state={event.state} />
            {event.frozen ? <StatusChip label="Frozen" tone="danger" /> : null}
            {event.inviteVersion === undefined ? null : (
              <StatusChip label={`Invite #${event.inviteVersion}`} />
            )}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted">
            Hosted by {event.ownerDisplayName} · {event.memberCount}{" "}
            {event.memberCount === 1 ? "member" : "members"}
          </p>
          {note === undefined ? null : <p className="mt-0.5 text-sm text-faint">{note}</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={EVENT_ACTION_COPY[action].tone === "danger" ? "danger" : "secondary"}
              onClick={() => {
                setOpen((current) => (current === action ? undefined : action));
              }}
            >
              {EVENT_ACTION_COPY[action].label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showMembers}
            onClick={() => {
              setShowMembers((current) => !current);
            }}
          >
            {showMembers ? "Hide members" : "Members"}
          </Button>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <Figure label="Pending" value={event.counts.pending} />
        <Figure label="Approved" value={event.counts.approved} />
        <Figure label="Declined" value={event.counts.declined} />
        <Figure label="Processing" value={event.processing} />
        <Figure label="Files" value={event.assetCount} />
        <Figure label="Storage" value={formatBytes(event.storageBytes)} />
      </dl>

      {open === "rotateCode" ? (
        <RotateCodeDialog
          event={event}
          onDone={() => {
            setOpen(undefined);
          }}
        />
      ) : open === undefined ? null : (
        <EventLifecycleDialog
          event={event}
          action={open}
          onDone={() => {
            setOpen(undefined);
          }}
        />
      )}

      {showMembers ? <EventMemberships eventId={event.id} className="mt-4" /> : null}
    </li>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-faint">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function EventLifecycleDialog({
  event,
  action,
  onDone,
}: {
  readonly event: AdminEvent;
  readonly action: Exclude<AdminEventAction, "rotateCode">;
  readonly onDone: () => void;
}) {
  const schedule = useMutation(adminApi.scheduleEventDeletion);
  const restore = useMutation(adminApi.restoreEvent);

  const run = useCallback(
    async (reason: string) => {
      if (action === "scheduleDeletion") await schedule({ eventId: event.id, reason });
      else await restore({ eventId: event.id, reason });
      onDone();
    },
    [action, event.id, onDone, restore, schedule],
  );

  return (
    <ConfirmAction
      copy={EVENT_ACTION_COPY[action]}
      subject={`${event.name} · hosted by ${event.ownerDisplayName}`}
      onConfirm={run}
      onCancel={onDone}
    />
  );
}

/**
 * Rotation from the console, with the specific-value option.
 *
 * PLAN.md puts "specific-value code rotation" first on the cut list; it was not
 * cut, and it is here. The collision check is genuinely the backend's — only
 * Convex can know whether another party already holds a number — so the form
 * validates format and entropy locally and reports the server's refusal verbatim
 * when it comes back. `RotateCodeFields` owns that; see its own file.
 */
function RotateCodeDialog({
  event,
  onDone,
}: {
  readonly event: AdminEvent;
  readonly onDone: () => void;
}) {
  const rotate = useMutation(adminApi.rotateEventCode);
  const form = useRotateCodeForm();
  const [result, setResult] = useState<
    { version: number; code: string; revoked: number } | undefined
  >(undefined);

  const run = useCallback(
    async (reason: string) => {
      const outcome = await rotate({
        eventId: event.id,
        mode: form.mode,
        ...(form.mode === "specific" ? { specificCode: form.code } : {}),
        keepExistingMemberships: form.keepMemberships,
        reason,
      });
      setResult({
        version: outcome.version,
        code: outcome.code,
        revoked: outcome.revokedMemberships,
      });
    },
    [event.id, form.code, form.keepMemberships, form.mode, rotate],
  );

  if (result !== undefined) {
    return (
      <Callout tone="success" live="polite" className="mt-3">
        <p className="text-ink">
          Rotated to invite #{result.version}. The new code is{" "}
          <span className="text-code font-semibold">{groupJoinCode(result.code)}</span>.
        </p>
        <p className="mt-1">
          {result.revoked === 0
            ? "Everybody already in stayed in."
            : `${result.revoked} ${result.revoked === 1 ? "guest was" : "guests were"} removed and can re-join with the new code.`}{" "}
          Tell the host — anything they printed is now wrong.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={onDone}>
            Done
          </Button>
        </div>
      </Callout>
    );
  }

  return (
    <ConfirmAction
      copy={EVENT_ACTION_COPY.rotateCode}
      subject={`${event.name} · hosted by ${event.ownerDisplayName}`}
      onConfirm={run}
      onCancel={onDone}
      blocked={form.blocked}
    >
      <RotateCodeFields form={form} eventId={event.id} />
    </ConfirmAction>
  );
}
