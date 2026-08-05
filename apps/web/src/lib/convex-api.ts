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
 *
 * The Sprint 5 `cohosts` and `admin` groups were written here first, while
 * `client-api.ts` was being edited by another agent. They were moved across at
 * integration, so this file is a seam again and nothing in `apps/web` describes
 * a wire shape.
 */

import { backendApi } from "@partybooth/backend/client-api";

export {
  backendApi,
  type AccountDeletionResult,
  type AvatarUploadRequestArgs,
  type BackendApi,
  type BlockedAccount,
  type CreateEventResult,
  type CurrentInvite,
  type CurrentUser,
  type EventCounts,
  type EventHome,
  type EventId,
  type EventOverview,
  type EventSummary,
  type FlaggedItem,
  type GuestMember,
  type InviteVersionId,
  type JoinInvite,
  type JoinPreview,
  type MediaId,
  type MediaItem,
  type MembershipId,
  type ModerationResult,
  type PublicGalleryItem,
  type RecentSubmission,
  type RefreshRolesResult,
  type ReportId,
  type ReportResult,
  type RotateInviteResult,
  type SetEventStateResult,
  type SlideshowPage,
  type StorageStatus,
  type UpdateProfileResult,
  type UploadCompletionResult,
  type UploadGrantId,
  type UploadGrantRequestArgs,
  type UserId,
} from "@partybooth/backend/client-api";

/**
 * Co-hosts and the admin console — the Sprint 5 groups.
 *
 * These describe `convex/cohosts.ts` and `convex/admin.ts` and live in
 * `client-api.ts` with everything else. `AdminApi` and `CohostApi` are no longer
 * named types: the groups are members of `BackendApi`, so there is one surface
 * rather than one surface and two satellites.
 */
export type {
  AdminAccount,
  AdminEvent,
  AdminJobHealth,
  AuditEventId,
  AuditRow,
  CohostInvitation,
  CohostInvitationId,
  CohostInvitationStatus,
  CohostList,
  CohostMember,
  OrganiserInvitationId,
} from "@partybooth/backend/client-api";

/** Co-host management, for the organiser console's settings page. */
export const cohostApi = backendApi.cohosts;

/** The global-admin console. */
export const adminApi = backendApi.admin;
