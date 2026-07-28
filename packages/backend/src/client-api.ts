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
import type {
  MediaFileRole,
  MediaSource,
  MediaState,
  MediaType,
  ModerationActionName,
  ModerationRefusal,
  ReportReason,
  ReportStatus,
} from "@partybooth/contracts/media";
import type { EventRole } from "@partybooth/contracts/roles";
import type { StorageRegion } from "@partybooth/contracts/storage";
import type { GrantResult, UploadCompletionOutcome } from "@partybooth/contracts/upload";
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
  /**
   * The version of the user terms this account agreed to, if any.
   *
   * Compare with `TERMS_VERSION` through `hasAcceptedTerms` rather than by hand
   * — see `@partybooth/contracts/terms`. An account that has not accepted the
   * current version cannot be issued an upload grant.
   */
  readonly acceptedTermsVersion?: string;
}

/** `users.updateProfile`. */
export interface UpdateProfileResult {
  readonly displayName: string;
  readonly avatarKey?: string;
  /** Stamped on the first confirmation and never moved afterwards. */
  readonly onboardedAt: number;
  readonly acceptedTermsVersion?: string;
}

/** `users.acceptTerms`. */
export interface AcceptTermsResult {
  readonly acceptedTermsVersion: string;
  readonly acceptedTermsAt: number;
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

/* ---- Media ---------------------------------------------------------------- */

export type MediaId = string;
export type UploadGrantId = string;

/**
 * `media.ts → mediaViewValidator` — one item, as a client is allowed to see it.
 *
 * There is deliberately **no file key** on this type and there must never be
 * one. A provider key names an object directly, so handing one to a client
 * turns a permission-checked read into a bearer credential that never expires.
 * `url` is a short-lived signed URL minted after the permission check, and
 * `urlExpiresAt` is when a client should stop trusting it — a Convex query
 * re-runs when its data changes, not when the clock moves, so a long-lived
 * subscription has to refresh rather than assume.
 *
 * `url` is absent while an item is still `processing`, and also when the
 * deployment has no storage credentials: a gallery that renders a status with no
 * thumbnail is a better failure than one that throws.
 */
export interface MediaItem {
  readonly id: MediaId;
  readonly eventId: EventId;
  readonly captureId: string;
  readonly state: MediaState;
  readonly mediaType: MediaType;
  readonly fromLibrary: boolean;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly uploaderUserId: UserId;
  readonly uploaderDisplayName: string;
  readonly isOwn: boolean;
  readonly createdAt: number;
  readonly capturedAt?: number;
  readonly uploadedAt?: number;
  readonly moderatedAt?: number;
  /**
   * How many members have reported this item, and when it was first flagged.
   *
   * **Present for hosts only.** A guest learning that three people reported the
   * photo next to theirs is a leak, and telling an uploader they have been
   * reported turns a report into a confrontation.
   */
  readonly reportCount?: number;
  readonly flaggedAt?: number;
  /**
   * The **original**. Absent while processing, when storage is unreachable, and —
   * for a viewer who is neither the submitter nor a host — whenever the client
   * did not confirm it re-encoded away the EXIF/GPS block (ADR 0004 §7).
   */
  readonly url?: string;
  readonly urlExpiresAt?: number;
  /**
   * The artefact to render: a downscaled image for a photo, a short muted clip
   * for a video. Since Sprint 4 this is what a fellow guest is served when the
   * original is withheld — "serve the derivative" rather than "serve nothing"
   * (ADR 0008). Absent when no derivative has landed yet.
   */
  readonly previewUrl?: string;
  readonly previewUrlExpiresAt?: number;
  /** A video's still frame, for the thumbnail and the first painted frame. */
  readonly posterUrl?: string;
  readonly posterUrlExpiresAt?: number;
}

/**
 * `media.requestUploadGrant` arguments. Mirrors `uploadGrantRequestSchema`.
 *
 * The index signature is what `DefaultFunctionArgs` requires of anything that
 * crosses the wire as a Convex argument object; it is not an invitation to send
 * extra fields — the mutation's own validator rejects them.
 */
export interface UploadGrantRequestArgs {
  readonly [key: string]: unknown;
  readonly eventId: EventId;
  /** Client-generated and stable across retries. Uploads are idempotent on it. */
  readonly captureId: string;
  readonly mediaType: MediaType;
  /**
   * Which artefact of the capture this is. Omitted means `original`, which is
   * what every Sprint-3 call meant and still means.
   *
   * A derivative (`preview`, `poster`) is a **separate grant for the same
   * `captureId`**, held to its own much tighter cap, and **refused unless
   * `sourceMetadataStripped` is `true`** — it is the artefact third parties are
   * served, so there the claim is a precondition rather than a record. ADR 0008.
   */
  readonly fileRole?: MediaFileRole;
  readonly byteSize: number;
  readonly mimeType: string;
  /** Lower-case hex SHA-256 of the exact bytes about to be sent. */
  readonly checksum: string;
  readonly durationSeconds?: number;
  readonly capturedAt?: number;
  readonly mediaSource?: MediaSource;
  readonly fromLibrary?: boolean;
  /**
   * Whether the client **re-encoded** the bytes first — see ADR 0004. This is
   * the half a derivative grant requires.
   */
  readonly sourceMetadataStripped?: boolean;
  /**
   * Whether the file **carries no location fix** — the half the read path
   * consults (`mayServeOriginal`).
   *
   * Absent means "same as the re-encode claim", which is what every Sprint-3
   * call meant, so omitting it is always safe. Send it explicitly only when the
   * two differ: a recorded clip that could not be transcoded but that the client
   * can still vouch for. See `MetadataClaim` in `@partybooth/contracts/media`.
   */
  readonly sourceCarriesNoLocation?: boolean;
}

/** `media.completeUpload` — the outcome of registering a stored file. */
export interface UploadCompletionResult {
  readonly outcome: UploadCompletionOutcome;
  readonly mediaId?: MediaId;
  readonly state?: MediaState;
  readonly reason?: string;
}

/** `media.storageStatus` — host-only diagnostics. Never contains a token. */
export interface StorageStatus {
  readonly region: StorageRegion;
  readonly provider: string;
  readonly configured: boolean;
  readonly appId?: string;
  readonly callbackConfigured: boolean;
}

/**
 * Withdrawn items whose bytes are still in storage.
 *
 * A row with `deletedAt` set and no `storageDeletedAt` is the one shape in the
 * schema that contradicts a promise made to a guest, and nothing asked for it
 * until this existed. It carries counts, never file keys.
 */
export interface StuckPurges {
  readonly count: number;
  readonly items: readonly {
    readonly id: MediaId;
    readonly captureId: string;
    readonly deletedAt?: number;
    readonly outstandingKeys: number;
    readonly storageRegion: StorageRegion;
  }[];
}

/* ---- Moderation, reports and blocks --------------------------------------- */

export type ReportId = string;

/**
 * `moderation.moderate` — the result of one tap or of a selection of forty.
 *
 * **Partial success is the contract.** A grid that has been live for thirty
 * seconds contains items another host has dealt with and items the submitter has
 * withdrawn since, so every item is attempted and the refusals come back
 * itemised. The mutation throws only for failures of the *request*.
 */
export interface ModerationResult {
  /** Items whose state actually moved. */
  readonly changed: number;
  /** Items already where the action would have put them — a no-op, not an error. */
  readonly unchanged: number;
  readonly refused: readonly {
    readonly mediaId: MediaId;
    readonly reason: ModerationRefusal;
    readonly message: string;
  }[];
  readonly results: readonly {
    readonly mediaId: MediaId;
    readonly state?: MediaState;
    readonly changed?: boolean;
  }[];
}

/** `moderation.report`. Idempotent per `(media, reporter)`. */
export interface ReportResult {
  readonly reportId: ReportId;
  /** `false` when this reporter had already reported this item. */
  readonly created: boolean;
  /**
   * How many members have reported this item. **Hosts only** — a guest is never
   * told, for the same reason `MediaView.reportCount` is host-only: a tally a
   * guest can poll by pressing the button again is a step towards identifying
   * who else pressed it.
   */
  readonly reportCount?: number;
}

/**
 * `moderation.flagged` — a reported item with its complaints.
 *
 * The reporters' free text is here, for the one audience that has to read it.
 * **Who** reported is never returned: a host who knows which guest reported which
 * other guest is a host who can be asked to take sides.
 */
export interface FlaggedItem {
  readonly media: MediaItem;
  readonly reports: readonly {
    readonly id: ReportId;
    readonly reason: ReportReason;
    readonly status: ReportStatus;
    readonly details?: string;
    readonly createdAt: number;
  }[];
}

/** `blocks.myBlocks` — the Settings list App Review looks for. */
export interface BlockedAccount {
  readonly userId: UserId;
  readonly displayName: string;
  readonly eventId?: EventId;
  readonly createdAt: number;
}

/* ---- Organiser home and slideshow ----------------------------------------- */

/** `stats.overview` — numbers only, so a global admin may read it. */
export interface EventOverview {
  readonly pending: number;
  readonly approved: number;
  readonly declined: number;
  readonly total: number;
  /** Uploads still in flight — deliberately outside the pending badge. */
  readonly processing: number;
  readonly flagged: number;
  readonly byType: { readonly photo: number; readonly video: number };
  readonly byState: {
    readonly processing: number;
    readonly pending: number;
    readonly approved: number;
    readonly declined: number;
  };
  /** Approximate: the sum of the byte sizes on the record, derivatives included. */
  readonly storageBytes: number;
  readonly contributorCount: number;
  readonly topContributors: readonly {
    readonly userId: UserId;
    readonly displayName: string;
    readonly approved: number;
    readonly total: number;
  }[];
}

/** `stats.recentSubmissions` — thumbnails, so hosts only. */
export interface RecentSubmission {
  readonly media: MediaItem;
  readonly state: MediaState;
  readonly mediaType: MediaType;
}

/**
 * `slideshow.feed` — one page of the show.
 *
 * `nextCursor` is what the client asks with next time. A re-run with a full
 * cursor returns an empty page, which is what keeps the currently-displayed photo
 * on screen instead of restarting the show every time somebody approves
 * something. **Shuffle is the client's job** — the server's order has to be
 * stable for the cursor to mean anything.
 */
export interface SlideshowPage {
  readonly items: readonly MediaItem[];
  readonly nextCursor?: string;
  /** `true` when the page was capped, so ask again at once. */
  readonly hasMore: boolean;
  /** Approved items in the event, ignoring the cursor. For "12 of 240". */
  readonly total: number;
  /**
   * Every approved id this viewer may see, ignoring the cursor.
   *
   * A cursor can only add. This is how a client learns about **removal** — an
   * item a host has declined, revoked or that a block now hides — so a photo
   * taken off the wall mid-party comes off the television at once instead of
   * cycling for the rest of the session behind a still-live signed URL.
   */
  readonly approvedIds: readonly MediaId[];
  /** `false` when the list above was truncated. Do not prune when it is. */
  readonly approvedIdsComplete: boolean;
}

/** `users.requestAccountDeletion` — Apple's in-app deletion requirement. */
export interface AccountDeletionResult {
  readonly accountState: string;
  /** When the purge becomes due — thirty days out. */
  readonly scheduledAt: number | null;
}

/* -------------------------------------------------------------------------- */
/* The surface                                                                */
/* -------------------------------------------------------------------------- */

export interface BackendApi {
  readonly users: {
    readonly currentUser: Query<NoArgs, CurrentUser | null>;
    readonly updateProfile: Mutation<
      { displayName: string; avatarKey?: string; acceptedTermsVersion?: string },
      UpdateProfileResult
    >;
    /**
     * Agree to the current user terms.
     *
     * Onboarding takes acceptance alongside the name, which covers every new
     * account; this is for the two cases it does not — an account that predates
     * the terms, and everybody after `TERMS_VERSION` moves. Play's UGC policy
     * asks for accepted terms before content is created, so an account without
     * one is refused an upload grant with `termsNotAccepted`.
     */
    readonly acceptTerms: Mutation<{ version: string }, AcceptTermsResult>;
    readonly refreshRoles: Mutation<NoArgs, RefreshRolesResult>;
    /**
     * Delete this account, from inside the app (Apple 5.1.1(v)).
     *
     * Moves to `deletionScheduled` and revokes access **immediately**. Thirty
     * days later `deletion.runDueDeletions` erases the account and its
     * associated data — media, stored objects, memberships, blocks, push
     * devices and the Better Auth credential. Until then submissions stay in
     * their party with the attribution removed, so a host mid-event does not
     * lose the evening and a change of mind is still possible.
     */
    readonly requestAccountDeletion: Mutation<{ reason?: string }, AccountDeletionResult>;
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
  readonly media: {
    /**
     * Short-lived, single-use permission to send one exact file.
     *
     * The result is a **value**, not an exception, for every outcome — including
     * "the host paused the party" and "that photo is too big". A Convex mutation
     * that throws rolls its own writes back, so a handler that charges a
     * throttle and then raises has charged nothing; the same shape also keeps
     * the client's error copy in one place.
     */
    readonly requestUploadGrant: Mutation<
      UploadGrantRequestArgs,
      GrantResult<UploadGrantId, EventId>
    >;
    /**
     * The client says its own upload finished. Creates the media row if the
     * provider callback has not got here first, and asserts nothing about what
     * is actually in storage.
     *
     * It also answers with what the grant **authorised** — `mediaType`,
     * `byteSize`, `mimeType` — which is the only server-minted description of
     * the upload the UploadThing middleware in `apps/web` can get hold of. It
     * refuses a ticket that disagrees, before any bytes move. The caller has
     * already proven it holds the grant, so this discloses nothing it did not
     * send.
     */
    readonly confirmUpload: Mutation<
      { secret: string },
      {
        mediaId: MediaId | null;
        state: MediaState | null;
        mediaType: MediaType | null;
        /** Which artefact the grant authorised — the cap the edge applies. */
        fileRole: MediaFileRole | null;
        byteSize: number | null;
        mimeType: string | null;
      }
    >;
    /**
     * **Server-only** — the UploadThing route handler in `apps/web`, never a
     * browser or the app. Needs `UPLOAD_CALLBACK_SECRET` as well as the grant.
     */
    readonly completeUpload: Mutation<
      {
        callbackSecret: string;
        secret: string;
        fileKey: string;
        byteSize: number;
        mimeType?: string;
        checksum?: string;
        width?: number;
        height?: number;
        durationSeconds?: number;
      },
      UploadCompletionResult
    >;
    /** Submitter-only, any state, permanent. */
    readonly withdraw: Mutation<{ mediaId: MediaId; reason?: string }, { state: MediaState }>;
    readonly myMedia: Query<{ eventId: EventId }, MediaItem[]>;
    readonly eventMedia: Query<
      { eventId: EventId; states?: readonly MediaState[]; limit?: number },
      MediaItem[]
    >;
    readonly storageStatus: Query<{ eventId: EventId }, StorageStatus>;
    /** Host-only. Withdrawn rows whose objects a purge never removed. */
    readonly stuckPurges: Query<{ eventId: EventId; limit?: number }, StuckPurges>;
  };
  readonly moderation: {
    /**
     * Approve, decline or revoke — one item or a selection of up to 200.
     *
     * One mutation for both, because the grid's single tap and its "select all
     * and approve" are the same operation with a different array length.
     * `revoke` refuses anything not currently `approved`.
     */
    readonly moderate: Mutation<
      {
        eventId: EventId;
        mediaIds: readonly MediaId[];
        action: ModerationActionName;
        reason?: string;
      },
      ModerationResult
    >;
    /** The host's queue: flagged first, then oldest first. */
    readonly pending: Query<{ eventId: EventId; limit?: number }, MediaItem[]>;
    /**
     * Report somebody else's item. Any member may; it **flags** the item for a
     * host and moderates nothing, because auto-hiding on report would hand any
     * guest a veto over any other guest's photograph.
     */
    readonly report: Mutation<
      { mediaId: MediaId; reason: ReportReason; details?: string },
      ReportResult
    >;
    readonly resolveReport: Mutation<
      { reportId: ReportId; status: "actioned" | "dismissed"; reason?: string },
      { status: ReportStatus; stillFlagged: boolean }
    >;
    readonly flagged: Query<{ eventId: EventId; limit?: number }, FlaggedItem[]>;
  };
  readonly blocks: {
    /**
     * Stop seeing another guest. Per-account and global, silent, and a filter on
     * **your own** reads: nothing changes for anybody else and no membership is
     * touched. Blocking is not ejecting.
     */
    readonly block: Mutation<
      { eventId: EventId; userId: UserId },
      { blocked: boolean; created: boolean }
    >;
    readonly unblock: Mutation<{ userId: UserId }, { blocked: boolean; removed: boolean }>;
    readonly myBlocks: Query<NoArgs, BlockedAccount[]>;
  };
  readonly slideshow: {
    readonly feed: Query<{ eventId: EventId; after?: string; limit?: number }, SlideshowPage>;
  };
  readonly stats: {
    /** Numbers only — a global admin may read this and must not read the next. */
    readonly overview: Query<{ eventId: EventId; contributorLimit?: number }, EventOverview>;
    /** Thumbnails, so host-only: admins never look at guests' photos. */
    readonly recentSubmissions: Query<
      { eventId: EventId; recentLimit?: number },
      RecentSubmission[]
    >;
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
