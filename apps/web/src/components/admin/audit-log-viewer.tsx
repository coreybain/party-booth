"use client";

import { useQuery } from "convex/react";
import { useId, useState } from "react";

import { AdminSearch, AdminTableShell, EmptyRow } from "@/components/admin/table";
import { ToggleField } from "@/components/ui/toggle-field";
import { StatusChip } from "@/components/ui/status-chip";
import {
  AUDIT_GROUPS,
  auditActionLabel,
  auditGroupLabel,
  auditRowIsSuspect,
  DEFAULT_AUDIT_FILTERS,
  filterAuditRows,
  isKnownAuditAction,
} from "@/lib/admin/audit-view";
import { adminApi, type AuditRow } from "@/lib/convex-api";
import { formatRelative } from "@/lib/datetime";
import { useNow } from "@/lib/use-now";

/**
 * The audit log. **Read-only, and there is no mutation in this file.**
 *
 * That is the whole design constraint: `auditEvents` is append-only, nothing in
 * the product edits or deletes a row, and a console with a delete button next to
 * an audit row is not an audit log. PLAN.md calls the rows immutable and this
 * page is the demonstration.
 *
 * Two kinds of filter, split by where they run:
 *
 * - **Server-side** (`limit`) changes which rows arrive. Filtering by event or
 *   actor is a query argument the backend supports; the console reaches those by
 *   link from the tables rather than by a picker here, because a picker over
 *   every account in the beta is a worse control than a row you were already
 *   looking at.
 * - **Client-side** (group, free text, has-a-reason) narrows what is on screen,
 *   so typing does not re-subscribe on every keystroke.
 *
 * A row whose action is on `AUDIT_ACTIONS_REQUIRING_REASON` and yet carries no
 * reason is flagged rather than hidden. It should be impossible —
 * `writeAuditEvent` throws instead of writing one — so if one appears, something
 * wrote to the table without going through the writer, and that is the incident.
 */
const PAGE_SIZES = [50, 200, 500] as const;

export function AuditLogViewer() {
  const limitId = useId();
  const groupId = useId();

  const [limit, setLimit] = useState<number>(PAGE_SIZES[0]);
  const [filters, setFilters] = useState(DEFAULT_AUDIT_FILTERS);
  const rows = useQuery(adminApi.auditLog, { limit });
  const now = useNow();

  const shown = rows === undefined ? undefined : filterAuditRows(rows, filters);

  return (
    <AdminTableShell
      title="Audit log"
      description="Append-only. Every privileged action, its actor and the reason they gave. Nothing here can be edited or removed."
      search={
        <div className="space-y-3">
          <AdminSearch
            label="Search the audit log"
            placeholder="Action, actor or reason"
            value={filters.search}
            onChange={(search) => {
              setFilters((current) => ({ ...current, search }));
            }}
          />

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor={groupId} className="mb-1.5 block text-sm font-medium text-muted">
                Area
              </label>
              <select
                id={groupId}
                value={filters.group}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, group: event.target.value }));
                }}
                className="h-10 rounded-xl border border-line bg-surface px-3 text-sm text-ink"
              >
                <option value="all">Everything</option>
                {AUDIT_GROUPS.map((group) => (
                  <option key={group} value={group}>
                    {auditGroupLabel(group)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={limitId} className="mb-1.5 block text-sm font-medium text-muted">
                Rows fetched
              </label>
              <select
                id={limitId}
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                }}
                className="h-10 rounded-xl border border-line bg-surface px-3 text-sm text-ink"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    Newest {size}
                  </option>
                ))}
              </select>
            </div>

            <ToggleField
              label="Only rows with a reason"
              checked={filters.withReasonOnly}
              onChange={(withReasonOnly) => {
                setFilters((current) => ({ ...current, withReasonOnly }));
              }}
            />
          </div>
        </div>
      }
      total={rows?.length}
      shown={shown?.length}
    >
      {shown === undefined ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : shown.length === 0 ? (
        <EmptyRow>
          {rows !== undefined && rows.length > 0
            ? "Nothing matches those filters."
            : "Nothing has been recorded yet."}
        </EmptyRow>
      ) : (
        <ol className="divide-y divide-line">
          {shown.map((row) => (
            <AuditRowView key={row.id} row={row} now={now} />
          ))}
        </ol>
      )}
    </AdminTableShell>
  );
}

function AuditRowView({ row, now }: { readonly row: AuditRow; readonly now: number }) {
  const suspect = auditRowIsSuspect(row);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{auditActionLabel(row.action)}</span>
          <StatusChip label={row.subjectType} />
          {isKnownAuditAction(row.action) ? null : (
            <StatusChip label="Unknown action" tone="warning" />
          )}
          {suspect ? <StatusChip label="No reason recorded" tone="danger" /> : null}
        </div>
        <span className="shrink-0 text-sm tabular-nums text-faint">
          {now === 0 ? null : formatRelative(row.createdAt, now)}
        </span>
      </div>

      <p className="mt-0.5 text-sm text-muted">
        {row.actorDisplayName ?? "System"}
        {row.actorRole === undefined ? null : ` · ${row.actorRole}`}
        {row.eventId === undefined ? null : " · in an event"}
      </p>

      {row.reason === undefined || row.reason.trim().length === 0 ? null : (
        <p className="mt-1 text-sm text-ink">&ldquo;{row.reason}&rdquo;</p>
      )}
    </li>
  );
}
