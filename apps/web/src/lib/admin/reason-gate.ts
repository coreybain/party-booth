import { adminReasonSchema } from "@/lib/contracts";

/**
 * The reason gate: nothing destructive happens in `/admin` until somebody has
 * typed why.
 *
 * PLAN.md's rule for the console is "confirmation + reason + immutable audit on
 * **every** action", and this is the first of those three. The other two are
 * elsewhere on purpose — `writeAuditEvent` in Convex throws rather than writing
 * a row with a blank reason, so the requirement survives a `curl` that never
 * loaded this file. What lives here is the half a human interacts with:
 *
 * - the confirm button is **disabled** until the reason parses, rather than
 *   enabled-and-then-rejected, because a dialog that lets you press the
 *   irreversible button and *then* complains has already taught you to press it
 *   without reading;
 * - the validation is `adminReasonSchema` itself — the same three-character
 *   floor and 280-character ceiling `parseInput` applies — so a reason the
 *   console accepts is never one the mutation refuses.
 */

export interface ReasonGate {
  /** Exactly what is in the input. */
  readonly value: string;
  /** What would be sent — `adminReasonSchema` trims. */
  readonly trimmed: string;
  readonly ok: boolean;
  /** The schema's own message, so the console never writes its own copy. */
  readonly error?: string;
  /** Characters left before the ceiling. Negative once it is past it. */
  readonly remaining: number;
}

export const REASON_MAX_LENGTH = 280;

/** Parse a typed reason. Pure, and safe to call on every keystroke. */
export function checkReason(value: string): ReasonGate {
  const trimmed = value.trim();
  const parsed = adminReasonSchema.safeParse(value);
  const remaining = REASON_MAX_LENGTH - trimmed.length;

  if (parsed.success) return { value, trimmed: parsed.data, ok: true, remaining };

  return {
    value,
    trimmed,
    ok: false,
    error: parsed.error.issues[0]?.message ?? "Give a reason — it goes in the audit log.",
    remaining,
  };
}

/**
 * Whether the confirm button in a reason-gated dialog may be pressed.
 *
 * The empty field is **not** an error state: a dialog that opens shouting at you
 * for not having typed anything yet is noise, and the button being dead already
 * says what is needed. So `touched` decides whether the message shows, and the
 * gate alone decides whether the button works.
 */
export function confirmEnabled(gate: ReasonGate, pending: boolean): boolean {
  return gate.ok && !pending;
}

/** The message to show under the field, if any. */
export function reasonMessage(gate: ReasonGate, touched: boolean): string | undefined {
  if (gate.ok || !touched) return undefined;
  if (gate.trimmed.length === 0) return undefined;
  return gate.error;
}
