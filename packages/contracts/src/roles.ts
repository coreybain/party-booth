import { z } from "zod";

/**
 * Every role a subject can hold when a permission check runs.
 *
 * - `globalAdmin` — platform operator. Runs `/admin`. Deliberately has **no**
 *   access to media and **no** impersonation (PLAN.md).
 * - `owner` — created the event; the only role that can delete it or hand it on.
 * - `cohost` — helps run the event: moderates, rotates invites, presents the
 *   slideshow. Cannot delete, transfer ownership, or change event settings.
 * - `guest` — attends the event: uploads, sees their own media and the approved
 *   gallery.
 */
export const ROLES = ["globalAdmin", "owner", "cohost", "guest"] as const;

export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES);

/**
 * Roles that are stored on a `memberships` row. `globalAdmin` is a property of
 * the account (server-side allowlist), not of a membership, so it is absent.
 */
export const EVENT_ROLES = ["owner", "cohost", "guest"] as const;

export type EventRole = (typeof EVENT_ROLES)[number];

export const eventRoleSchema = z.enum(EVENT_ROLES);

/**
 * Seniority **within one event**. Intentionally not extended to `globalAdmin`:
 * an admin is not "above" an owner, it is a different axis with a different
 * (media-free) capability set.
 */
export const EVENT_ROLE_RANK: Record<EventRole, number> = {
  guest: 0,
  cohost: 1,
  owner: 2,
};

export function isEventRole(role: Role): role is EventRole {
  return role !== "globalAdmin";
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `role` is at least as senior as `minimum` inside an event. */
export function hasEventRank(role: EventRole, minimum: EventRole): boolean {
  return EVENT_ROLE_RANK[role] >= EVENT_ROLE_RANK[minimum];
}

/** Roles that see the host surfaces (organiser console, Host tab). */
export const HOST_ROLES = ["owner", "cohost"] as const satisfies readonly EventRole[];

export type HostRole = (typeof HOST_ROLES)[number];

export function isHostRole(role: Role): role is HostRole {
  return role === "owner" || role === "cohost";
}
