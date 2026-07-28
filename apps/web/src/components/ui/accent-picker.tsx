"use client";

import { useId } from "react";

import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { ACCENT_SWATCHES } from "@/lib/event-form";

export interface AccentPickerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly error?: string;
}

/**
 * The event's accent colour, from a fixed palette.
 *
 * A palette rather than `<input type="color">`: every swatch is checked to stay
 * legible as a thin stripe on a near-black card and behind `--color-on-accent`
 * text, and a free picker is how an event ends up marked in a colour nobody can
 * see. See `ACCENT_SWATCHES` for the values and the reasoning.
 */
export function AccentPicker({ value, onChange, disabled = false, error }: AccentPickerProps) {
  const name = useId();

  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-muted">Accent colour</legend>
      <div className="flex flex-wrap gap-2">
        {ACCENT_SWATCHES.map((option) => {
          const selected = option.value === value;
          const colour = "swatch" in option ? option.swatch : option.value;
          return (
            <label
              key={option.label}
              title={option.label}
              className={cn(
                "relative grid h-11 w-11 cursor-pointer place-items-center rounded-xl border-2 transition-colors",
                selected ? "border-ink" : "border-transparent hover:border-line-strong",
                disabled && "cursor-not-allowed opacity-50",
              )}
              style={{ backgroundColor: colour }}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  onChange(option.value);
                }}
                className="sr-only"
              />
              <span className="sr-only">{option.label}</span>
              {selected ? (
                <CheckIcon size={18} className="text-on-accent" aria-hidden="true" />
              ) : null}
            </label>
          );
        })}
      </div>
      {error ? <p className="mt-1.5 text-sm text-danger">{error}</p> : null}
    </fieldset>
  );
}
