"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CodeField } from "@/components/ui/code-field";
import { JOIN_CODE_LENGTH } from "@/lib/contracts";
import { isCompleteJoinCode } from "@/lib/otp";

export interface JoinCodeFormProps {
  /** Called with the six digits once the field holds a complete code. */
  readonly onSubmit: (code: string) => void;
  readonly pending?: boolean;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly submitLabel?: string;
}

/**
 * Six-digit event-code entry — the fallback for a guest who cannot scan the QR.
 *
 * Presentational on purpose: it owns the field and nothing else, so the caller
 * decides what a code *means*. That split matters because looking a code up is
 * enumeration-sensitive and therefore authenticated, throttled and audited in
 * Convex; a form that called it directly would be a form that could be pointed
 * at a million codes.
 *
 * The input behaviour is the part worth getting right on a phone: numeric
 * keypad, paste tolerance (`normaliseDigits` strips the spaces in "482 913"),
 * a hard length clamp, and a submit that stays disabled until the code is
 * complete — `isCompleteJoinCode` delegates to `@partybooth/contracts`, so the
 * button can never enable on something the backend would reject out of hand.
 */
export function JoinCodeForm({
  onSubmit,
  pending = false,
  error,
  disabled = false,
  submitLabel = "Find the event",
}: JoinCodeFormProps) {
  const [code, setCode] = useState("");
  const complete = isCompleteJoinCode(code);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !pending && !disabled) onSubmit(code);
      }}
    >
      <CodeField
        label="Event code"
        name="event-code"
        value={code}
        onChange={setCode}
        length={JOIN_CODE_LENGTH}
        // Not `one-time-code`: this is not an OTP, and offering the SMS code
        // from an unrelated app is worse than offering nothing.
        autoComplete="off"
        hint="The six digits printed under the QR code."
        error={error}
        disabled={disabled || pending}
        autoFocus
      />

      <Button type="submit" size="lg" fullWidth loading={pending} disabled={disabled || !complete}>
        {submitLabel}
      </Button>
    </form>
  );
}
