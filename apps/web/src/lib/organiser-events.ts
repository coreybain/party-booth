import type { EventSummary } from "@/lib/convex-api";
import { isHostRole } from "@/lib/contracts";

type EventMembership = Pick<EventSummary, "role">;

/** Keep only memberships that grant access to an event's organiser controls. */
export function organiserEvents<T extends EventMembership>(events: readonly T[]): T[] {
  return events.filter((event) => isHostRole(event.role));
}
