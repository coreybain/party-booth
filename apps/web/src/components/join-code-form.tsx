"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeField } from "@/components/ui/code-field";
import { JOIN_CODE_LENGTH } from "@/lib/contracts";
import { isCompleteJoinCode } from "@/lib/otp";

/**
 * Six-digit event-code entry — the fallback when a guest cannot scan the QR.
 *
 * The input behaviour is real (numeric keypad, paste tolerance, length clamp)
 * because that is the bit worth testing on a phone before the party. The
 * submit path is a stub: joining is authenticated, rate-limited and
 * enumeration-protected in Convex, and lands in Sprint 2.
 *
 * TODO(Sprint 2): replace `handleSubmit` with the `joinByCode` mutation.
 * A wrong code must produce the *same* response as a code that does not exist —
 * never confirm that an event is real.
 */
export function JoinCodeForm() {
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <CodeField
        label="Event code"
        name="event-code"
        value={code}
        onChange={(next) => {
          setCode(next);
          setSubmitted(false);
        }}
        length={JOIN_CODE_LENGTH}
        autoComplete="off"
        hint="The six digits printed under the QR code."
      />

      <Button type="submit" size="lg" fullWidth disabled={!isCompleteJoinCode(code)}>
        Join event
      </Button>

      {submitted ? (
        <Callout tone="info" live="polite">
          Joining is not wired up yet — that lands in Sprint 2, together with guest sign-in.
        </Callout>
      ) : null}
    </form>
  );
}
