"use client";

import { FilterIcon, XIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import {
  activeModerationFilters,
  describeVisible,
  STATUS_FILTER_OPTIONS,
  TYPE_FILTER_OPTIONS,
  withoutModerationFilter,
  type ModerationCounts,
  type ModerationFilters,
  type StatusFilter,
  type SubmitterOption,
  type TypeFilter,
} from "@/lib/moderation/filters";

/**
 * Event totals plus a single filter menu. Active choices become individually
 * removable chips, so the compact control never hides what is narrowing the
 * moderation queue.
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
  const active = activeModerationFilters(filters, submitters);

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

      <div className="flex flex-wrap items-center gap-2">
        <FilterMenu filters={filters} submitters={submitters} onChange={onChange} />

        {active.map((filter) => (
          <span
            key={filter.key}
            className="inline-flex h-9 items-center gap-1 rounded-full border border-accent/35 bg-accent-soft px-3 pl-3.5 text-sm text-accent"
          >
            <span>{filter.label}</span>
            <button
              type="button"
              aria-label={`Remove ${filter.label} filter`}
              onClick={() => {
                onChange(withoutModerationFilter(filters, filter.key));
              }}
              className="ml-1 grid h-5 w-5 place-items-center rounded-full border border-accent/30 bg-accent/10 text-accent transition-colors hover:bg-accent hover:text-on-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <XIcon size={13} />
            </button>
          </span>
        ))}

        {active.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={onReset} className="rounded-full">
            Clear all
          </Button>
        ) : null}

        <span className="ml-auto text-xs text-faint" role="status" aria-live="polite">
          {describeVisible(shown, counts.total)}
        </span>
      </div>
    </div>
  );
}

function FilterMenu({
  filters,
  submitters,
  onChange,
}: {
  readonly filters: ModerationFilters;
  readonly submitters: readonly SubmitterOption[];
  readonly onChange: (next: ModerationFilters) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" aria-label="Choose moderation filters">
          <FilterIcon size={16} />
          Filters
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filters.status}
              onValueChange={(value) => {
                onChange({ ...filters, status: value as StatusFilter });
              }}
            >
              {STATUS_FILTER_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filters.mediaType}
              onValueChange={(value) => {
                onChange({ ...filters, mediaType: value as TypeFilter });
              }}
            >
              {TYPE_FILTER_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Submitter</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filters.submitter}
              onValueChange={(value) => {
                onChange({ ...filters, submitter: value });
              }}
            >
              <DropdownMenuRadioItem value="all">Everyone</DropdownMenuRadioItem>
              {submitters.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                    <span className="truncate">{option.label}</span>
                    <span className="text-xs tabular-nums text-faint">{option.count}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filters.flaggedOnly}
          onCheckedChange={(checked) => {
            onChange({ ...filters, flaggedOnly: checked === true });
          }}
        >
          Reported only
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.showDeclined}
          onCheckedChange={(checked) => {
            onChange({ ...filters, showDeclined: checked === true });
          }}
        >
          Show declined
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
