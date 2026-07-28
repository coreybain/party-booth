"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  describeVisible,
  isDefaultFilters,
  STATUS_FILTER_OPTIONS,
  TYPE_FILTER_OPTIONS,
  type ModerationCounts,
  type ModerationFilters,
  type StatusFilter,
  type SubmitterOption,
  type TypeFilter,
} from "@/lib/moderation/filters";

/**
 * The filter row above the grid.
 *
 * Everything here is a plain `<select>` or a plain `<button>` on purpose: a host
 * uses this one-handed on a phone in a dark room, and the platform's own select
 * wheel beats any listbox we would write this week (`ui/select-field.tsx` makes
 * the same argument at more length).
 *
 * The counts are of the **whole** event, not of the filtered view — see
 * `countModerationRows`. "12 pending" has to keep saying twelve while the host
 * is looking at approved items, or it stops being the number that tells them
 * whether to keep going.
 */

export interface ModerationFilterBarProps {
  readonly filters: ModerationFilters;
  readonly counts: ModerationCounts;
  readonly submitters: readonly SubmitterOption[];
  readonly shown: number;
  readonly onChange: (next: ModerationFilters) => void;
  readonly onReset: () => void;
}

export function ModerationFilterBar({
  filters,
  counts,
  submitters,
  shown,
  onChange,
  onReset,
}: ModerationFilterBarProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <CountChip label="Pending" value={counts.pending} tone="warning" />
        <CountChip label="Approved" value={counts.approved} tone="positive" />
        <CountChip label="Declined" value={counts.declined} tone="neutral" />
        {counts.flagged > 0 ? (
          <CountChip label="Reported" value={counts.flagged} tone="danger" />
        ) : null}
        {counts.processing > 0 ? (
          <CountChip label="Arriving" value={counts.processing} tone="progress" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <InlineSelect
          label="Status"
          value={filters.status}
          onChange={(value) => {
            onChange({ ...filters, status: value as StatusFilter });
          }}
          options={STATUS_FILTER_OPTIONS}
        />
        <InlineSelect
          label="Type"
          value={filters.mediaType}
          onChange={(value) => {
            onChange({ ...filters, mediaType: value as TypeFilter });
          }}
          options={TYPE_FILTER_OPTIONS}
        />
        <InlineSelect
          label="Submitter"
          value={filters.submitter}
          onChange={(value) => {
            onChange({ ...filters, submitter: value });
          }}
          options={[
            { value: "all", label: "Everyone" },
            ...submitters.map((option) => ({
              value: option.value,
              label: `${option.label} (${String(option.count)})`,
            })),
          ]}
        />

        <Toggle
          pressed={filters.flaggedOnly}
          onClick={() => {
            onChange({ ...filters, flaggedOnly: !filters.flaggedOnly });
          }}
        >
          Reported only
        </Toggle>
        <Toggle
          pressed={filters.showDeclined}
          onClick={() => {
            onChange({ ...filters, showDeclined: !filters.showDeclined });
          }}
        >
          Show declined
        </Toggle>

        {isDefaultFilters(filters) ? null : (
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
        )}

        <span className="ml-auto text-xs text-faint" role="status" aria-live="polite">
          {describeVisible(shown, counts.total)}
        </span>
      </div>
    </div>
  );
}

function CountChip({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: "warning" | "positive" | "neutral" | "danger" | "progress";
}) {
  const TONES = {
    warning: "border-warning/35 bg-warning/10 text-warning",
    positive: "border-positive/35 bg-positive/10 text-positive",
    neutral: "border-line bg-raised text-muted",
    danger: "border-danger/40 bg-danger/10 text-danger",
    progress: "border-accent/40 bg-accent/10 text-accent",
  } as const;

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        TONES[tone],
      )}
    >
      <span className="text-sm font-semibold tabular-nums">{value}</span>
      {label}
    </span>
  );
}

function InlineSelect({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</span>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink hover:border-line-strong"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({
  pressed,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-9 rounded-lg border px-3 text-sm transition-colors",
        pressed
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
