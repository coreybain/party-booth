/**
 * The clients' typed view of the Convex API.
 *
 * `convex codegen` can only emit the **generic** `_generated/api.d.ts` (`AnyApi`)
 * until a real deployment exists to introspect — see `packages/backend/README.md`.
 * Under `AnyApi` every function reference has `any` arguments and an `any`
 * result, so a typo in a function name, a renamed field, or a mutation that
 * gained a required argument all reach a phone before they reach the compiler.
 *
 * So this module declares the shape of the calls the clients actually make and
 * casts the generated object to it **once**. It lives in `packages/backend`
 * rather than in each app for the obvious reason: `apps/web` and `apps/mobile`
 * previously kept a hand-written copy each, which meant two descriptions of one
 * wire contract maintained separately — and the way that fails is silent. They
 * had already drifted (one typed `storageRegion` as `string`, the other as
 * `StorageRegion`). The backend owns the wire contract, so the backend owns the
 * description of it.
 *
 * Three rules keep this honest:
 *
 * 1. **Every domain type comes from `@partybooth/contracts`.** `EventState`,
 *    `EventRole`, `JoinResult` and friends are the same definitions the Convex
 *    validators are built from, so a contract change breaks this file rather
 *    than silently diverging from it. Only the field *lists* — which the
 *    backend's `v.object(...)` validators own — are restated below, with the
 *    function that returns each one named next to it.
 * 2. **Nothing else in either app imports `@partybooth/backend/api`.** Each app
 *    keeps a one-line seam (`src/lib/convex-api.ts`, `src/lib/api.ts`) that
 *    re-exports from here.
 * 3. **Results a client branches on are re-parsed at the call site** with the
 *    contract's own zod schema — `parseJoinResult` in
 *    `@partybooth/contracts/join`. The cast asserts a shape; parsing proves it.
 *
 * When `convex dev` runs against a real deployment and codegen becomes precise,
 * this file collapses to `export { api } from "../convex/_generated/api"` plus
 * the payload types, and no call site changes.
 */

import type { AccountState } from "@partybooth/contracts/accounts";
import type {
  EventState,
  HostSettableEventState,
  LaunchModerationMode,
  ModerationMode,
} from "@partybooth/contracts/events";
import type { JoinResult } from "@partybooth/contracts/join";
import type { EventRole } from "@partybooth/contracts/roles";
import type { StorageRegion } from "@partybooth/contracts/storage";
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";

import { api as generatedApi } from "../convex/_generated/api";

/* -------------------------------------------------------------------------- */
/* Ids                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convex document ids are branded `Id<"table">` inside `packages/backend` and
 * opaque strings everywhere else. A client never constructs one — it only
 * round-trips values the backend handed it — so a nominal alias documents
 * intent without pretending to a safety the wire cannot give.
 */
export type EventId = string;
export type UserId = string;
export type MembershipId = string;
export type InviteVersionId = string;

/* -------------------------------------------------------------------------- */
/* Function-reference shorthands                                              */
/* -------------------------------------------------------------------------- */

type Query<Args extends DefaultFunctionArgs, Result> = FunctionReference<
  "query",
  "public",
  Args,
  Result
>;

type Mutation<Args extends DefaultFunctionArgs, Result> = FunctionReference<
  "mutation",
  "public",
  Args,
  Result
>;

/** No-argument functions still take an object on the wire. */
type NoArgs = Record<string, never>;

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/** `users.currentUser` — the application-side user row, narrowed for a client. */
export interface CurrentUser {
  readonly id: UserId;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly avatarKey?: string;
  /**
   * When this human confirmed their own name. Absent means they never have,
   * which is what both shells read to decide whether to show the onboarding
   * screen — `displayName` cannot answer it, because it falls back to the local
   * part of the address and is therefore never empty.
   */
  readonly onboardedAt?: number;
  readonly accountState: AccountState;
  /** Unlocked by an accepted organiser invitation. Gates event creation. */
  readonly isOrganiser: boolean;
  readonly isGlobalAdmin: boolean;
}

/** `users.updateProfile`. */
export interface UpdateProfileResult {
  readonly displayName: string;
  readonly avatarKey?: string;
  /** Stamped on the first confirmation and never moved afterwards. */
  readonly onboardedAt: number;
}

/** `users.refreshRoles` — the result of re-running verified-email matching. */
export interface RefreshRolesResult {
  readonly isOrganiser: boolean;
  /** `true` only on the run that flipped it, so the UI can say so once. */
  readonly organiserUnlocked: boolean;
  /** Events this account was upgraded to co-host on by a matched invitation. */
  readonly cohostEventIds: readonly EventId[];
}

export interface EventCounts {
  readonly pending: number;
  readonly approved: number;
  readonly declined: number;
  readonly total: number;
}

/**
 * `events.ts → eventSummaryValidator`. One party, as this account sees it.
 * `role` is the caller's own membership role, which is what every affordance
 * check runs on.
 */
export interface EventSummary {
  readonly id: EventId;
  readonly name: string;
  readonly state: EventState;
  readonly moderationMode: ModerationMode;
  readonly startsAt: number;
  readonly endsAt?: number;
  readonly timeZone: string;
  readonly accentColor?: string;
  readonly coverKey?: string;
  readonly allowLibraryImport: boolean;
  readonly storageRegion: StorageRegion;
  readonly role: EventRole;
  readonly counts: EventCounts;
}

/** `events.home`. `invite` is present only for hosts and global admins. */
export interface EventHome {
  readonly event: EventSummary;
  readonly isHost: boolean;
  readonly memberCount: number;
  readonly invite?: {
    readonly version: number;
    readonly code: string;
    readonly token: string;
  };
}

/**
 * `join.ts → previewValidator` — the "yes, this is the right party" check shown
 * before a guest commits. Deliberately thin: name, when, whose. `null` covers
 * every failure (unknown credential, superseded version, not joinable) with one
 * value, because telling them apart is exactly what the join design refuses to
 * do.
 */
export interface JoinPreview {
  readonly eventId: EventId;
  readonly name: string;
  readonly state: EventState;
  readonly startsAt: number;
  readonly endsAt?: number;
  readonly timeZone: string;
  readonly accentColor?: string;
  readonly coverKey?: string;
  readonly hostDisplayName: string;
  /** `true` when this account is already in — the button says "Open", not "Join". */
  readonly alreadyMember: boolean;
}

/** The two ways a guest arrives, exactly as `joinInputSchema` discriminates them. */
export type JoinInvite =
  | { readonly via: "token"; readonly token: string }
  | { readonly via: "code"; readonly code: string };

/** `events.create`. */
export interface CreateEventResult {
  readonly eventId: EventId;
  readonly inviteVersionId: InviteVersionId;
  readonly code: string;
  readonly token: string;
}

/** `events.setState`. `reissuedCode` is set when re-opening freed a stale code. */
export interface SetEventStateResult {
  readonly state: EventState;
  readonly reissuedCode?: string;
}

/* -------------------------------------------------------------------------- */
/* The surface                                                                */
/* -------------------------------------------------------------------------- */

export interface BackendApi {
  readonly users: {
    readonly currentUser: Query<NoArgs, CurrentUser | null>;
    readonly updateProfile: Mutation<
      { displayName: string; avatarKey?: string },
      UpdateProfileResult
    >;
    readonly refreshRoles: Mutation<NoArgs, RefreshRolesResult>;
  };
  readonly events: {
    readonly create: Mutation<
      {
        name: string;
        schedule: { startsAt: number; endsAt?: number; timeZone: string };
        moderationMode?: LaunchModerationMode;
        accentColor?: string;
        allowLibraryImport?: boolean;
        initialState?: "draft" | "scheduled";
      },
      CreateEventResult
    >;
    readonly update: Mutation<
      {
        eventId: EventId;
        name?: string;
        schedule?: { startsAt: number; endsAt?: number; timeZone: string };
        moderationMode?: LaunchModerationMode;
        accentColor?: string;
        allowLibraryImport?: boolean;
      },
      null
    >;
    readonly setState: Mutation<
      { eventId: EventId; state: HostSettableEventState; reason?: string },
      SetEventStateResult
    >;
    readonly setActiveEvent: Mutation<{ eventId: EventId | null }, null>;
    readonly myEvents: Query<NoArgs, EventSummary[]>;
    readonly activeEvent: Query<NoArgs, EventSummary | null>;
    readonly home: Query<{ eventId: EventId }, EventHome>;
  };
  readonly join: {
    readonly join: Mutation<
      { invite: JoinInvite; networkKey?: string },
      JoinResult<EventId, MembershipId>
    >;
    readonly previewByToken: Query<{ token: string }, JoinPreview | null>;
    readonly previewByCode: Mutation<{ code: string; networkKey?: string }, JoinPreview | null>;
  };
}

/**
 * The single cast. `generatedApi` is `AnyApi` today, so this widens nothing that
 * was being checked — it narrows `any` to the shapes above.
 */
export const backendApi = generatedApi as unknown as BackendApi;
