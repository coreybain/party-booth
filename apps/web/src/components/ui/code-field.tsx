"use client";

import { useId } from "react";

import { cn } from "@/lib/cn";
import { normaliseDigits } from "@/lib/otp";

export interface CodeFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly length: number;
  readonly error?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  /** `one-time-code` lets iOS offer the code straight from the Messages/Mail banner. */
  readonly autoComplete?: string;
  readonly name?: string;
}

/**
 * A single wide input for a six-digit code, rather than N boxes.
 *
 * One input is the accessible and reliable choice on a phone: iOS/Android
 * autofill of a one-time code targets a single field, paste works, and the
 * caret never gets lost between boxes. Digits are letter-spaced so it still
 * reads as a code.
 */
export function CodeField({
  label,
  value,
  onChange,
  length,
  error,
  hint,
  disabled = false,
  autoFocus = false,
  autoComplete = "one-time-code",
  name,
}: CodeFieldProps) {
  const generatedId = useId();
  const inputId = name ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        value={value}
        onChange={(event) => {
          onChange(normaliseDigits(event.target.value, length));
        }}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={length}
        placeholder={"0".repeat(length)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "text-code h-16 w-full rounded-xl border bg-surface text-center text-2xl text-ink",
          // The letter-spacing pushes the visual centre right; nudge it back.
          "indent-[0.35em]",
          "placeholder:text-faint/50",
          "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          error ? "border-danger" : "border-line hover:border-line-strong",
        )}
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
