"use client";

import { useCallback, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import {
  checkReason,
  confirmEnabled,
  REASON_MAX_LENGTH,
  reasonMessage,
} from "@/lib/admin/reason-gate";
import type { AdminActionCopy } from "@/lib/admin/actions";
import { cn } from "@/lib/cn";

/**
 * The console's one confirmation dialog. **Every** privileged action goes
 * through it.
 *
 * PLAN.md: "confirmation + reason + immutable audit on every action". This is
 * the first two of those three, and it is one component rather than a pattern
 * repeated per table so that the rule cannot be half-applied — a second dialog
 * written in a hurry is how one action ends up without a reason field.
 *
 * The properties worth stating:
 *
 * - **The confirm button is dead until the reason parses.** Not
 *   enabled-then-rejected: a dialog that lets you press the irreversible button
 *   and then complains has already taught you to press it without reading. The
 *   check is `adminReasonSchema` — the same one `parseInput` runs in Convex — so
 *   nothing this accepts is refused on the far side.
 * - **The consequences are listed before the field**, in the order they happen,
 *   so the reason is typed *after* reading what it is for.
 * - **The reason is what goes in the audit row.** The copy says so, because an
 *   administrator who knows their sentence will be read writes a better one.
 * - **Failure keeps the dialog open with the text intact.** Losing a typed
 *   reason to a dropped socket is how the second attempt gets "asdf".
 */

export interface ConfirmActionProps {
  readonly copy: AdminActionCopy;
  /** What is being acted on — an email, an event name. Shown in the heading. */
  readonly subject: string;
  /** Extra controls above the reason field: the rotation form's mode picker. */
  readonly children?: ReactNode;
  /** Resolve to run the mutation. Rejecting keeps the dialog open. */
  readonly onConfirm: (reason: string) => Promise<void>;
  readonly onCancel: () => void;
  /** Blocks confirm for a reason of the caller's own — e.g. an invalid code. */
  readonly blocked?: string | undefined;
}

export function ConfirmAction({
  copy,
  subject,
  children,
  onConfirm,
  onCancel,
  blocked,
}: ConfirmActionProps) {
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const gate = checkReason(reason);
  const message = reasonMessage(gate, touched);
  const enabled = confirmEnabled(gate, pending) && blocked === undefined;

  const submit = useCallback(async () => {
    if (!gate.ok) return;
    setPending(true);
    setError(undefined);
    try {
      await onConfirm(gate.trimmed);
    } catch (caught) {
      // The typed reason survives on purpose.
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [gate.ok, gate.trimmed, onConfirm]);

  return (
    <div
      role="group"
      aria-label={copy.title}
      className={cn(
        "mt-3 rounded-2xl border p-4",
        copy.tone === "danger" ? "border-danger/40 bg-danger/5" : "border-line bg-raised",
      )}
    >
      <h3 className="text-sm font-semibold text-ink">{copy.title}</h3>
      <p className="mt-0.5 text-sm text-muted">{subject}</p>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
        {copy.consequences.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {children ? <div className="mt-4">{children}</div> : null}

      <div className="mt-4">
        <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-muted">
          Why are you doing this?
        </label>
        <textarea
          id={fieldId}
          rows={2}
          value={reason}
          maxLength={REASON_MAX_LENGTH + 40}
          onChange={(event) => {
            setReason(event.target.value);
            setTouched(true);
          }}
          aria-invalid={message === undefined ? undefined : true}
          aria-describedby={`${fieldId}-hint`}
          className={cn(
            "w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-ink",
            "placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50",
            message === undefined ? "border-line hover:border-line-strong" : "border-danger",
          )}
          placeholder="Repeated reports from three guests; asked to pause pending review."
          disabled={pending}
        />
        <p
          id={`${fieldId}-hint`}
          className={cn("mt-1.5 text-sm", message === undefined ? "text-faint" : "text-danger")}
        >
          {message ??
            `This is written to the audit log against your account and cannot be edited or removed. ${gate.remaining} characters left.`}
        </p>
      </div>

      {blocked === undefined ? null : (
        <Callout tone="warning" className="mt-3">
          {blocked}
        </Callout>
      )}

      {error === undefined ? null : (
        <Callout tone="danger" live="assertive" className="mt-3">
          {error}
        </Callout>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant={copy.tone === "danger" ? "danger" : "primary"}
          size="sm"
          loading={pending}
          disabled={!enabled}
          onClick={() => {
            void submit();
          }}
        >
          {copy.confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
