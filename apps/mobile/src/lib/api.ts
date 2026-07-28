/**
 * The seam between `apps/mobile` and the Convex API.
 *
 * The typed view itself lives in `@partybooth/backend/client-api`, next to the
 * functions it describes. It used to be restated here, and separately in
 * `apps/web`, which meant two hand-written descriptions of one wire contract
 * maintained by different people — and the way that fails is silent, because
 * `AnyApi` makes every mismatch an `any` rather than an error. This file is the
 * app's one-line view onto it, so nothing else in the app imports the backend
 * directly.
 *
 * `api` is exported under that name rather than `backendApi` because it is what
 * `useQuery(api.events.myEvents)` reads as, and it is what the import becomes
 * when precise codegen lands.
 *
 * Results a screen branches on are still re-parsed at the call site with the
 * contract's own zod schema (`parseJoinResult` in `src/lib/join.ts`) — the cast
 * asserts a shape, the parse proves it.
 */

import { backendApi } from "@partybooth/backend/client-api";

export const api = backendApi;

export type {
  BackendApi as MobileApi,
  CurrentInvite,
  CurrentUser,
  EventCounts,
  EventId,
  EventSummary,
  FlaggedItem,
  JoinInvite,
  JoinPreview,
  MediaId,
  MediaItem,
  MembershipId,
  ModerationResult,
  PushPreferences,
  PushStatus,
  RefreshRolesResult,
  RotateInviteResult,
  UpdateProfileResult,
  UserId,
} from "@partybooth/backend/client-api";
