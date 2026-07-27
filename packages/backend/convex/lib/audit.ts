import { auditActionRequiresReason, type AuditAction, type Role } from "@partybooth/contracts";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AuditSubject } from "./validators";

/**
 * The audit log writer.
 *
 * `auditEvents` is **append-only**. This module is the only place that inserts
 * into it, and nothing anywhere patches or deletes a row. PLAN.md requires
 * "confirmation + reason + immutable audit on every action" in the admin
 * console; the reason requirement is enforced here rather than in the UI, so a
 * mutation cannot skip it by not being called from the console.
 */

export interface AuditEntry {
  action: AuditAction;
  subjectType: AuditSubject;
  /** The row the action was about. Omitted for platform-wide actions. */
  subjectId?: string | undefined;
  /** Absent for system-initiated actions (scheduled jobs, callbacks). */
  actor?: { userId: Id<"users">; role?: Role | undefined } | undefined;
  /** Set whenever the action belongs to an event. Drives the per-event view. */
  eventId?: Id<"events"> | undefined;
  reason?: string | undefined;
  /** Small, non-PII detail bag: old/new state, counts, which code rotated. */
  metadata?: Record<string, unknown> | undefined;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number | undefined;
}

export class MissingAuditReasonError extends Error {
  override readonly name = "MissingAuditReasonError";
  constructor(action: AuditAction) {
    super(
      `Audit action "${action}" requires a reason. It is destructive or account-affecting, so the admin console must collect one and pass it through.`,
    );
  }
}

/**
 * Append one audit row.
 *
 * Throws — rather than writing a row with a blank reason — when the action
 * demands one. That is deliberate: a half-recorded lock is worse than a failed
 * one, because the next person reading the log has no way to know it happened
 * without cause.
 */
export async function writeAuditEvent(
  ctx: MutationCtx,
  entry: AuditEntry,
): Promise<Id<"auditEvents">> {
  const reason = entry.reason?.trim();

  if (auditActionRequiresReason(entry.action) && !reason) {
    throw new MissingAuditReasonError(entry.action);
  }

  return await ctx.db.insert("auditEvents", {
    action: entry.action,
    subjectType: entry.subjectType,
    ...(entry.subjectId === undefined ? {} : { subjectId: entry.subjectId }),
    ...(entry.actor === undefined
      ? {}
      : {
          actorUserId: entry.actor.userId,
          ...(entry.actor.role === undefined ? {} : { actorRole: entry.actor.role }),
        }),
    ...(entry.eventId === undefined ? {} : { eventId: entry.eventId }),
    ...(reason === undefined || reason === "" ? {} : { reason }),
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    createdAt: entry.now ?? Date.now(),
  });
}

/**
 * Convenience for the common "an actor did something to an event" shape.
 */
export async function writeEventAudit(
  ctx: MutationCtx,
  params: {
    action: AuditAction;
    event: Doc<"events">;
    actor?: { user: Doc<"users">; role?: Role | undefined } | undefined;
    reason?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    now?: number | undefined;
  },
): Promise<Id<"auditEvents">> {
  return await writeAuditEvent(ctx, {
    action: params.action,
    subjectType: "event",
    subjectId: params.event._id,
    eventId: params.event._id,
    ...(params.actor === undefined
      ? {}
      : { actor: { userId: params.actor.user._id, role: params.actor.role } }),
    reason: params.reason,
    metadata: params.metadata,
    now: params.now,
  });
}
