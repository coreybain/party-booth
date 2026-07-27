import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  /** Static helper text shown under the field. */
  readonly hint?: string;
  /** Validation failure. Replaces the hint and marks the input invalid. */
  readonly error?: string;
  /** Visually hide the label but keep it for screen readers. */
  readonly hideLabel?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  hideLabel = false,
  id,
  className,
  ...props
}: TextFieldProps) {
  const inputId = id ?? props.name ?? label.toLowerCase().replace(/\s+/g, "-");
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        className={cn("mb-1.5 block text-sm font-medium text-muted", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "h-12 w-full rounded-xl border bg-surface px-3.5 text-base text-ink",
          "placeholder:text-faint",
          "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          error ? "border-danger" : "border-line hover:border-line-strong",
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={`${inputId}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
