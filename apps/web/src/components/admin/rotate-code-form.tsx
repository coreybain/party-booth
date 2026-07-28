"use client";

import { useQuery } from "convex/react";
import { useMemo, useState } from "react";

import { Code } from "@/components/ui/code";
import { TextField } from "@/components/ui/text-field";
import { ToggleField } from "@/components/ui/toggle-field";
import {
  normalizeEventCode,
  validateSpecificEventCode,
  type AdminRotationMode,
} from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { groupJoinCode } from "@/lib/event-view";
import { ROTATION_CONSEQUENCES } from "@/lib/rotation";

/**
 * The extra controls the console's rotation dialog needs on top of the reason.
 *
 * Two decisions live here, and the split between them and the backend matters:
 *
 * - **Random or specific.** `validateSpecificEventCode` — the contract's own —
 *   checks the shape and refuses a low-entropy number like `111111` or `123456`
 *   *before* a round trip. What it cannot check is whether another party already
 *   holds those digits, which is a database question; the mutation answers that
 *   one and its refusal is shown verbatim rather than paraphrased.
 * - **Keep or revoke.** The same choice the host's own modal forces, with the
 *   same words from `ROTATION_CONSEQUENCES` — a sweep from the console and a
 *   sweep from the settings page are the same event and must not be described
 *   two different ways. It defaults to **keep** here, unlike the host's modal
 *   which defaults to nothing: an administrator rotating somebody else's party
 *   has an even weaker claim to be emptying it, so the safe option is the one
 *   already selected and the destructive one is a deliberate move.
 */

export interface RotateCodeForm {
  readonly mode: AdminRotationMode;
  readonly setMode: (mode: AdminRotationMode) => void;
  readonly code: string;
  readonly setCode: (code: string) => void;
  readonly keepMemberships: boolean;
  readonly setKeepMemberships: (keep: boolean) => void;
  /** Non-`undefined` disables confirm, with this sentence shown. */
  readonly blocked: string | undefined;
  /** The field-level message, when the typed code is the problem. */
  readonly codeError: string | undefined;
}

export function useRotateCodeForm(): RotateCodeForm {
  const [mode, setMode] = useState<AdminRotationMode>("random");
  const [code, setCode] = useState("");
  const [keepMemberships, setKeepMemberships] = useState(true);

  const codeError = useMemo(() => {
    if (mode !== "specific") return undefined;
    const normalised = normalizeEventCode(code);
    if (normalised.length === 0) return undefined;
    const validated = validateSpecificEventCode(normalised);
    if (validated.ok) return undefined;
    return validated.reason === "format"
      ? "A join code is exactly six digits."
      : "That code is too easy to guess. Pick another.";
  }, [code, mode]);

  const blocked =
    mode !== "specific"
      ? undefined
      : normalizeEventCode(code).length === 0
        ? "Type the six digits you want, or switch back to a random code."
        : codeError;

  return {
    mode,
    setMode,
    code,
    setCode,
    keepMemberships,
    setKeepMemberships,
    blocked,
    codeError,
  };
}

export function RotateCodeFields({
  form,
  eventId,
}: {
  readonly form: RotateCodeForm;
  readonly eventId: string;
}) {
  /*
   * The number being replaced, asked for one event at a time.
   *
   * `admin.events` deliberately omits the code from its list rows; this is the
   * host-only single-event read that `event.viewInviteCode` allows a global
   * admin. Showing it is what stops "rotate 482913 → 482913", which the backend
   * also refuses but which is a much better message here.
   */
  const current = useQuery(backendApi.invites.current, { eventId });

  return (
    <div className="space-y-4">
      {current === undefined || current === null ? null : (
        <p className="text-sm text-muted">
          Replacing <Code>{groupJoinCode(current.code)}</Code> (invite #{current.version}).
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-muted">The new code</legend>
        <div className="flex flex-wrap gap-2">
          {(["random", "specific"] as const).map((option) => (
            <label
              key={option}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                form.mode === option
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line bg-surface text-muted hover:border-line-strong"
              }`}
            >
              <input
                type="radio"
                name="rotation-mode"
                value={option}
                checked={form.mode === option}
                onChange={() => {
                  form.setMode(option);
                }}
                className="h-4 w-4"
              />
              {option === "random" ? "Random six digits" : "A specific number"}
            </label>
          ))}
        </div>
      </fieldset>

      {form.mode === "specific" ? (
        <TextField
          label="New six-digit code"
          name="specific-code"
          inputMode="numeric"
          autoComplete="off"
          maxLength={7}
          value={form.code}
          onChange={(event) => {
            form.setCode(event.target.value);
          }}
          {...(form.codeError === undefined ? {} : { error: form.codeError })}
          hint="Only Convex can tell you whether another party already has it — that check runs on submit."
        />
      ) : null}

      <ToggleField
        label="Keep everyone who has already joined"
        description={
          form.keepMemberships
            ? ROTATION_CONSEQUENCES.keep.summary
            : ROTATION_CONSEQUENCES.revoke.summary
        }
        checked={form.keepMemberships}
        onChange={form.setKeepMemberships}
      />

      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        {(form.keepMemberships
          ? ROTATION_CONSEQUENCES.keep.effects
          : ROTATION_CONSEQUENCES.revoke.effects
        ).map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
    </div>
  );
}
