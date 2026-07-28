import type { SelectHTMLAttributes } from "react";

import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * A native `<select>`.
 *
 * Native rather than a custom listbox because the only long list in this app is
 * the time-zone picker, and on a phone the platform wheel is faster, searchable
 * by keystroke, and accessible without a line of code. The chevron is drawn on
 * top rather than by `appearance`, so it matches the rest of the UI without
 * losing the native popup.
 */
export function SelectField({
  label,
  hint,
  error,
  options,
  id,
  className,
  ...props
}: SelectFieldProps) {
  const selectId = id ?? props.name ?? label.toLowerCase().replace(/\s+/g, "-");
  const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined;

  return (
    <div className="w-full">
      <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-12 w-full appearance-none rounded-xl border bg-surface pl-3.5 pr-10",
            "text-base text-ink transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error ? "border-danger" : "border-line hover:border-line-strong",
            className,
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          size={18}
          className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-faint"
        />
      </div>
      {error ? (
        <p id={`${selectId}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${selectId}-hint`} className="mt-1.5 text-sm text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
