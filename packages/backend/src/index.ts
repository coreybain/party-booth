/**
 * `@partybooth/backend` — the Convex deployment.
 *
 * The functions themselves live in `convex/` and are called through the
 * generated API:
 *
 * ```ts
 * import { api } from "@partybooth/backend/api";
 * const user = useQuery(api.users.currentUser);
 * ```
 *
 * This entry point exports only the things a client needs to *interpret* what
 * the backend returns — error codes and the schema-local enums. Domain types
 * (roles, states, permissions) come from `@partybooth/contracts` instead; a
 * client should never need to import the backend for those.
 */

export { ERROR_CODES, isAppError, type AppErrorData, type ErrorCode } from "../convex/lib/errors";

export {
  AUDIT_SUBJECTS,
  DELETION_JOB_STATES,
  DELETION_SUBJECTS,
  INVITE_VERSION_STATUSES,
  MEMBERSHIP_STATUSES,
  ORGANISER_INVITATION_STATUSES,
  type AuditSubject,
  type DeletionJobState,
  type DeletionSubject,
  type InviteVersionStatus,
  type MembershipStatus,
  type OrganiserInvitationStatus,
} from "../convex/lib/validators";
