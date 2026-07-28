"use client";

import { useId } from "react";

import { cn } from "@/lib/cn";

export interface ToggleFieldProps {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

/**
 * A checkbox that reads as a switch.
 *
 * A real `<input type="checkbox">` with the visual chrome drawn from its
 * `peer-checked:` state, so it is keyboard-operable and announced correctly
 * without any ARIA of its own.
 */
export function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: ToggleFieldProps) {
  const id = useId();

  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        className={cn(
          "relative mt-0.5 h-6 w-10 shrink-0 cursor-pointer rounded-full border border-line bg-raised",
          "transition-colors peer-checked:border-accent peer-checked:bg-accent",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
          "after:absolute after:left-0.5 after:top-0.5 after:h-4.5 after:w-4.5 after:rounded-full",
          "after:bg-ink after:transition-transform peer-checked:after:translate-x-4",
          "peer-checked:after:bg-on-accent",
          disabled && "cursor-not-allowed opacity-50",
        )}
        aria-hidden="true"
      />
      <label htmlFor={id} className={cn("cursor-pointer", disabled && "cursor-not-allowed")}>
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-sm text-muted">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
