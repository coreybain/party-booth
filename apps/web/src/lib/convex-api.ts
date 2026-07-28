/**
 * The seam between `apps/web` and the Convex API.
 *
 * The typed view itself lives in `@partybooth/backend/client-api`, next to the
 * functions it describes, because `apps/mobile` needs the same description and
 * two hand-written copies of one wire contract is a drift bug waiting to be
 * shipped. This file exists so nothing in `apps/web` reaches past it — the same
 * arrangement `src/lib/contracts.ts` has with `@partybooth/contracts`.
 *
 * When `convex dev` runs against a real deployment and codegen becomes precise,
 * `client-api.ts` collapses to a re-export and neither this file nor any call
 * site changes.
 */

export {
  backendApi,
  type BackendApi,
  type CreateEventResult,
  type CurrentUser,
  type EventCounts,
  type EventHome,
  type EventId,
  type EventSummary,
  type InviteVersionId,
  type JoinInvite,
  type JoinPreview,
  type MembershipId,
  type RefreshRolesResult,
  type SetEventStateResult,
  type UpdateProfileResult,
  type UserId,
} from "@partybooth/backend/client-api";
