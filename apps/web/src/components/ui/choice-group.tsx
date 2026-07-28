"use client";

import { useId } from "react";

import { cn } from "@/lib/cn";

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

export interface ChoiceGroupProps<T extends string> {
  readonly legend: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly choices: readonly Choice<T>[];
  readonly disabled?: boolean;
  readonly error?: string;
  readonly className?: string;
}

/**
 * A radio group rendered as tappable cards.
 *
 * Real `<input type="radio">` elements under the surface, so arrow-key
 * navigation, form semantics and screen-reader grouping all come for free —
 * this is the pattern a `role="radiogroup"` div gets wrong. The card is the
 * `<label>`, which makes the whole thing a 56 px touch target rather than a
 * 16 px dot.
 *
 * Used for the two settings a host changes under pressure: moderation mode, and
 * whether the code is live yet.
 */
export function ChoiceGroup<T extends string>({
  legend,
  value,
  onChange,
  choices,
  disabled = false,
  error,
  className,
}: ChoiceGroupProps<T>) {
  const name = useId();

  return (
    <fieldset className={cn("w-full", className)} aria-invalid={error ? true : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-muted">{legend}</legend>
      <div className="space-y-2">
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <label
              key={choice.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
                selected
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:border-line-strong",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  onChange(choice.value);
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{choice.label}</span>
                {choice.description ? (
                  <span className="mt-0.5 block text-sm text-muted">{choice.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? <p className="mt-1.5 text-sm text-danger">{error}</p> : null}
    </fieldset>
  );
}
