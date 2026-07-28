import { AUDIT_ACTION_NAMES, auditActionRequiresReason, isAuditAction } from "@/lib/contracts";
import type { AuditRow } from "@/lib/convex-api";

/**
 * The audit log, as something a person can read at 1 a.m.
 *
 * Two properties this file exists to preserve:
 *
 * 1. **The viewer is read-only and has no idea how to write.** There is no
 *    mutation anywhere near it and there never will be — an audit log a console
 *    can edit is not an audit log. Everything here is a projection.
 * 2. **An unknown action still renders.** `AUDIT_ACTIONS` grows every sprint and
 *    the log holds rows written by versions of the product that no longer exist,
 *    so {@link auditActionLabel} falls back to the raw string rather than
 *    rendering an empty cell. A log with holes in it is worse than a log with an
 *    ugly row in it.
 */

/** `"event.invite_rotated"` → `"event"`. The filter's coarse axis. */
export function auditActionGroup(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

/** Every group present in the vocabulary, in a stable order. */
export const AUDIT_GROUPS: readonly string[] = [
  ...new Set(AUDIT_ACTION_NAMES.map(auditActionGroup)),
];

const GROUP_LABELS: Record<string, string> = {
  organiser: "Organiser invitations",
  event: "Events",
  membership: "Memberships",
  media: "Media",
  user: "Blocks",
  account: "Accounts",
  push: "Push devices",
  admin: "Admin sign-in",
  auth: "Demo credential",
};

export function auditGroupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

/**
 * `"event.invite_rotated"` → `"Invite rotated"`.
 *
 * Derived rather than tabulated: a `Record<AuditAction, string>` is a second
 * list to keep in step with the first, and the first one grows every sprint.
 * The action names are already written as sentences with underscores in them.
 */
export function auditActionLabel(action: string): string {
  const dot = action.indexOf(".");
  const tail = dot === -1 ? action : action.slice(dot + 1);
  const words = tail.replace(/_/g, " ").trim();
  if (words.length === 0) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Is this a row the product knows about, or one from an older shape? */
export function isKnownAuditAction(action: string): boolean {
  return isAuditAction(action);
}

/**
 * Rows whose action is on `AUDIT_ACTIONS_REQUIRING_REASON` and yet arrived
 * without one.
 *
 * This should be impossible — `writeAuditEvent` throws instead of writing one —
 * which is exactly why the viewer flags it rather than hiding it. If a row like
 * this ever appears, something wrote to `auditEvents` without going through the
 * writer, and that is the incident.
 */
export function auditRowIsSuspect(row: AuditRow): boolean {
  return (
    isAuditAction(row.action) &&
    auditActionRequiresReason(row.action) &&
    (row.reason ?? "").trim().length === 0
  );
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

export interface AuditFilters {
  /** `"all"`, or one of {@link AUDIT_GROUPS}. */
  readonly group: string;
  /** Free text, matched against the action, the actor and the reason. */
  readonly search: string;
  /** Only rows that carry a reason. Useful for "show me the console's work". */
  readonly withReasonOnly: boolean;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  group: "all",
  search: "",
  withReasonOnly: false,
};

/**
 * Client-side, on top of whatever `admin.auditLog` returned.
 *
 * The **event** and **actor** filters are query arguments rather than predicates
 * here, because they change which rows the server sends; these three only narrow
 * what is already on screen, so doing them here keeps typing in the search box
 * from re-subscribing on every keystroke.
 */
export function filterAuditRows(
  rows: readonly AuditRow[],
  filters: AuditFilters,
): readonly AuditRow[] {
  const needle = filters.search.trim().toLowerCase();

  return rows.filter((row) => {
    if (filters.group !== "all" && auditActionGroup(row.action) !== filters.group) return false;
    if (filters.withReasonOnly && (row.reason ?? "").trim().length === 0) return false;
    if (needle.length === 0) return true;

    return [
      row.action,
      auditActionLabel(row.action),
      row.actorDisplayName ?? "",
      row.actorRole ?? "",
      row.subjectType,
      row.reason ?? "",
    ].some((field) => field.toLowerCase().includes(needle));
  });
}
