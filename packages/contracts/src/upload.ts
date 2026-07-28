import { z } from "zod";

import { acceptsUploads, type EventState } from "./events";
import {
  maxBytesFor,
  mediaTypeSchema,
  MEDIA_SOURCES,
  validateMediaFile,
  type MediaFileCandidate,
  type MediaRejectionReason,
  type MediaSource,
  type MediaType,
} from "./media";
import { captureIdSchema, checksumSchema } from "./schemas";
import { storageRegionSchema, type StorageRegion } from "./storage";

/**
 * Upload grants — the front half of the upload spine.
 *
 * A guest never talks to UploadThing on their own authority. They ask Convex for
 * a **grant**: a short-lived, single-use capability bound to one exact file for
 * one exact capture in one exact event. The route handler in `apps/web` refuses
 * to store anything without one, and consuming a grant is a transactional
 * read-decide-write, so two racing uploads cannot spend the same one.
 *
 * Everything in this file is pure — `now` and a plain state object in, a verdict
 * out — for the same reason `join.ts` is: the policy has to be testable with no
 * deployment and no credentials, and the client has to be able to apply exactly
 * the same rules before it wastes a guest's bandwidth.
 *
 * Three properties the rest of the pipeline leans on:
 *
 * 1. **Bound, not bearer-generic.** A grant names `eventId`, `captureId`,
 *    `mediaType`, `byteSize`, `checksum` and `storageRegion`. A body that does
 *    not match what was granted is refused at completion and the stray object is
 *    deleted — see {@link matchesGrant}.
 * 2. **Single use, then gone.** {@link GRANT_POLICY.ttlMs} is two minutes, which
 *    is a long time to start an upload and no time at all to sit in a log file.
 * 3. **The size caps are the contract's**, not the route handler's. `MEDIA_LIMITS`
 *    in `media.ts` is the one place photos are 20 MB and videos are 250 MB / 60 s;
 *    this file only decides when to consult it.
 */

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export const GRANT_POLICY = {
  /**
   * How long a grant stays usable.
   *
   * Two minutes is the window between "the client asked" and "the first byte
   * reached UploadThing", not the window for the whole upload — the grant is
   * checked when the upload *starts*. A 250 MB video on party wifi takes longer
   * than this to finish, and that is fine.
   */
  ttlMs: 2 * 60 * 1000,
  /**
   * Grants one account may be issued per window before it is made to wait.
   *
   * Sized for the worst honest case rather than the average one: auto-send fires
   * one grant per capture, and somebody photographing a dance floor in burst
   * mode is a guest, not an attacker. Sixty in five minutes is well past any
   * human rate and still cheap to enforce.
   */
  maxPerWindow: 60,
  windowMs: 5 * 60 * 1000,
  /** How long the account waits once it hits the ceiling. */
  cooldownMs: 60 * 1000,
} as const;

/**
 * What we persist per throttle key. Deliberately the same shape as
 * `JoinAttemptState` in `join.ts`, and for the same reason: Convex parallelises
 * and recycles isolates, so anything counted in memory is not a limit. Doing the
 * read-decide-write inside a mutation is what makes the ceiling real.
 *
 * It differs from the join throttle in what it counts. Joining throttles
 * **failures**, because a successful join is the thing we want to happen.
 * Uploading throttles **successes**, because an issued grant is itself the
 * scarce resource — so there is no equivalent of the "nothing but time returns
 * budget" argument here; the window rolling over is the only reset either way.
 */
export interface GrantAttemptState {
  /** Grants issued inside the current window. */
  issuedCount: number;
  windowStartedAt: number;
  lastIssuedAt: number;
  /** Set when the ceiling is hit. Cleared only by time. */
  cooldownUntil?: number | undefined;
}

export type GrantThrottleDecision =
  { allowed: true } | { allowed: false; reason: "throttled"; retryAfterMs: number };

/** Namespaced so the upload counter can never be confused with a join counter. */
export function accountGrantKey(userId: string): string {
  return `upload:${userId}`;
}

function windowElapsed(state: GrantAttemptState, now: number): boolean {
  return now - state.windowStartedAt >= GRANT_POLICY.windowMs;
}

/** May this account be issued another grant right now? */
export function canIssueGrant(
  state: GrantAttemptState | undefined,
  now: number,
): GrantThrottleDecision {
  if (state === undefined) return { allowed: true };
  if (state.cooldownUntil !== undefined && now < state.cooldownUntil) {
    return { allowed: false, reason: "throttled", retryAfterMs: state.cooldownUntil - now };
  }
  if (windowElapsed(state, now)) return { allowed: true };
  if (state.issuedCount >= GRANT_POLICY.maxPerWindow) {
    // The window has not rolled over and the budget is spent. Make them wait for
    // whichever comes first: the cooldown, or the window.
    const untilWindow = state.windowStartedAt + GRANT_POLICY.windowMs - now;
    return { allowed: false, reason: "throttled", retryAfterMs: Math.max(1, untilWindow) };
  }
  return { allowed: true };
}

/**
 * The state after a grant has been **issued**.
 *
 * A window that has elapsed starts a fresh one, so an evening of steady
 * photographing never accumulates into a lockout. Hitting the ceiling arms the
 * cooldown once; further issues cannot happen while it is armed, because
 * {@link canIssueGrant} refuses them.
 */
export function registerGrantIssued(
  state: GrantAttemptState | undefined,
  now: number,
): GrantAttemptState {
  if (state === undefined || windowElapsed(state, now)) {
    return { issuedCount: 1, windowStartedAt: now, lastIssuedAt: now };
  }

  const issuedCount = state.issuedCount + 1;
  return {
    issuedCount,
    windowStartedAt: state.windowStartedAt,
    lastIssuedAt: now,
    ...(issuedCount >= GRANT_POLICY.maxPerWindow
      ? { cooldownUntil: now + GRANT_POLICY.cooldownMs }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Grant lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * - `issued` — minted and not yet spent. The only usable state.
 * - `consumed` — an upload was accepted against it. Terminal.
 * - `expired` — the TTL ran out before anything arrived, or the capture it
 *   belonged to was withdrawn before the bytes did. Terminal.
 *
 * Expiry is a **fact about the clock**, so `isGrantUsable` treats a still-`issued`
 * row past its `expiresAt` as unusable whether or not anything has got round to
 * writing the status. The status is the tidying; the timestamp is the rule.
 */
export const GRANT_STATUSES = ["issued", "consumed", "expired"] as const;

export type GrantStatus = (typeof GRANT_STATUSES)[number];

export interface GrantRecord {
  status: GrantStatus;
  expiresAt: number;
  eventId: string;
  captureId: string;
  mediaType: MediaType;
  byteSize: number;
  checksum: string;
  storageRegion: StorageRegion;
}

export type GrantUsability =
  { usable: true } | { usable: false; reason: "alreadyConsumed" | "expired" };

export function isGrantUsable(
  grant: Pick<GrantRecord, "status" | "expiresAt">,
  now: number,
): GrantUsability {
  if (grant.status === "consumed") return { usable: false, reason: "alreadyConsumed" };
  if (grant.status === "expired" || now > grant.expiresAt) {
    return { usable: false, reason: "expired" };
  }
  return { usable: true };
}

export function grantExpiresAt(issuedAt: number): number {
  return issuedAt + GRANT_POLICY.ttlMs;
}

/* -------------------------------------------------------------------------- */
/* Matching a completed upload back to its grant                              */
/* -------------------------------------------------------------------------- */

/** What the storage provider says it actually stored. */
export interface CompletedUpload {
  /** Provider file key. Never leaves the server. */
  fileKey: string;
  byteSize: number;
  mimeType?: string | undefined;
  /** Recomputed client-side; absent when the provider could not supply one. */
  checksum?: string | undefined;
}

export type GrantMismatchReason = "byteSize" | "checksum";

export type GrantMatch = { ok: true } | { ok: false; reason: GrantMismatchReason };

/**
 * Does the stored object match what was granted?
 *
 * `byteSize` is authoritative and always checked: it is the field the size caps
 * were enforced against, so a body that grew between the grant and the store has
 * walked around the cap. `checksum` is checked only when the completion carries
 * one — the provider does not compute ours, so it arrives from the client, and
 * an absent value must not be treated as a match failure or every upload from a
 * client that cannot hash would be refused.
 *
 * A mismatch is not an error to shrug at: the object is deleted and the grant is
 * burned, because "something other than what was promised is now in private
 * storage" is exactly the case this binding exists to catch.
 */
export function matchesGrant(
  grant: Pick<GrantRecord, "byteSize" | "checksum">,
  completed: CompletedUpload,
): GrantMatch {
  if (completed.byteSize !== grant.byteSize) return { ok: false, reason: "byteSize" };
  if (completed.checksum !== undefined && completed.checksum !== grant.checksum) {
    return { ok: false, reason: "checksum" };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Whether a grant may be issued at all                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why an upload was refused.
 *
 * Unlike a join rejection, these **are** returned to the caller in full. There
 * is nothing to enumerate: you cannot reach this code without an active
 * membership of the event you named, so every reason here is a fact about your
 * own file or about a party you are already standing in. Telling a guest "that
 * video is too long" beats telling them "no".
 */
export const UPLOAD_REJECTION_REASONS = [
  /** The event is not `live` — draft, scheduled, paused, archived or on its way out. */
  "eventNotAcceptingUploads",
  /** `events.allowLibraryImport` is off and this came from the photo roll. */
  "libraryImportDisabled",
  "emptyFile",
  "tooLarge",
  "unsupportedMimeType",
  "missingDuration",
  "tooLong",
  /** This capture already has a media row. Retrying is fine; re-uploading is not. */
  "duplicateCapture",
  /** This capture was withdrawn. Withdrawal is permanent — see `media.withdraw`. */
  "captureWithdrawn",
] as const;

export type UploadRejectionReason = (typeof UPLOAD_REJECTION_REASONS)[number];

export const UPLOAD_REJECTION_MESSAGES: Record<UploadRejectionReason, string> = {
  eventNotAcceptingUploads: "This party is not accepting photos right now.",
  libraryImportDisabled: "The host has turned off adding photos from your library.",
  emptyFile: "That file is empty.",
  tooLarge: "That file is too big.",
  unsupportedMimeType: "That file format is not supported.",
  missingDuration: "Video duration is required.",
  tooLong: "That video is too long.",
  duplicateCapture: "That capture has already been uploaded.",
  captureWithdrawn: "That capture was withdrawn and cannot be uploaded again.",
};

export const UPLOAD_THROTTLED_MESSAGE = "Slow down a moment — too many uploads at once.";

/**
 * Refusals a later attempt genuinely cannot fix.
 *
 * `eventNotAcceptingUploads` and `libraryImportDisabled` are **deliberately
 * absent**. "This party is not accepting photos right now" is the single most
 * likely refusal at a real party — a host pauses the queue to catch up on
 * moderation and un-pauses two minutes later — and it is exactly the case where
 * a guest should not have to remember to press anything. Everything listed here
 * is a fact about the file, or a decision that has already been taken and will
 * not be untaken.
 *
 * Both clients consult this, and they must agree: `apps/mobile` uses it to
 * decide whether its durable queue keeps retrying on a timer, and `apps/web`
 * uses it to decide whether the retry button is offered at all. A permanence
 * rule that lived in one of them would give the same photo two different fates
 * depending on which client the guest happened to be holding.
 */
export const PERMANENT_UPLOAD_REJECTIONS = [
  "emptyFile",
  "tooLarge",
  "unsupportedMimeType",
  "missingDuration",
  "tooLong",
  "duplicateCapture",
  "captureWithdrawn",
] as const satisfies readonly UploadRejectionReason[];

export function isPermanentRejection(reason: UploadRejectionReason): boolean {
  return (PERMANENT_UPLOAD_REJECTIONS as readonly UploadRejectionReason[]).includes(reason);
}

export interface GrantEligibilityInput {
  event: { state: EventState; allowLibraryImport: boolean };
  mediaSource: MediaSource;
  file: MediaFileCandidate;
}

export type GrantEligibility =
  | { ok: true }
  | { ok: false; reason: UploadRejectionReason; message: string; limit?: number | undefined };

/**
 * Everything that can refuse a grant on the strength of the request alone.
 *
 * Ordered deliberately: the event gate first, then the host's library setting,
 * then the file itself. A guest whose party has been paused should be told the
 * party is paused, not that their photo is 21 MB — the first sentence is the one
 * that explains why trying again with a smaller file will not help.
 *
 * Video is accepted here even though the capture UI for it is Sprint 4. The
 * pipeline is deliberately type-agnostic: `MEDIA_LIMITS` already knows what a
 * video may weigh, and a media type that only becomes valid when a camera screen
 * ships is a media type that gets its validation written twice.
 */
export function checkGrantEligibility(input: GrantEligibilityInput): GrantEligibility {
  if (!acceptsUploads(input.event.state)) {
    return {
      ok: false,
      reason: "eventNotAcceptingUploads",
      message: UPLOAD_REJECTION_MESSAGES.eventNotAcceptingUploads,
    };
  }

  if (input.mediaSource === "library" && !input.event.allowLibraryImport) {
    return {
      ok: false,
      reason: "libraryImportDisabled",
      message: UPLOAD_REJECTION_MESSAGES.libraryImportDisabled,
    };
  }

  const file = validateMediaFile(input.file);
  if (!file.ok) {
    return {
      ok: false,
      reason: uploadReasonForFile(file.reason),
      message: file.message,
      ...(file.limit === undefined ? {} : { limit: file.limit }),
    };
  }

  return { ok: true };
}

/** The per-type ceiling this request will be held to. Handy for error copy. */
export function grantSizeCap(mediaType: MediaType): number {
  return maxBytesFor(mediaType);
}

/* -------------------------------------------------------------------------- */
/* The result a client sees                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A grant, as handed to the client.
 *
 * `secret` is the capability. It is returned exactly once, never stored in
 * plaintext (Convex keeps a SHA-256 of it, the way `userEmails` keeps a hashed
 * OTP), and never written to an audit row or a log line.
 *
 * There is no `fileKey` and no provider URL in here. The client posts the file
 * to our own route handler with the secret attached; the route handler is the
 * only thing that ever holds an UploadThing credential.
 */
export interface IssuedGrant<TGrantId extends string = string, TEventId extends string = string> {
  outcome: "granted";
  grantId: TGrantId;
  secret: string;
  eventId: TEventId;
  captureId: string;
  mediaType: MediaType;
  mediaSource: MediaSource;
  storageRegion: StorageRegion;
  byteSize: number;
  /** The cap this type is held to, so the client can show it in an error. */
  maxBytes: number;
  expiresAt: number;
}

export interface RejectedGrant {
  outcome: "rejected";
  reason: UploadRejectionReason;
  message: string;
}

export interface ThrottledGrant {
  outcome: "throttled";
  message: string;
  retryAfterMs: number;
}

export type GrantResult<TGrantId extends string = string, TEventId extends string = string> =
  IssuedGrant<TGrantId, TEventId> | RejectedGrant | ThrottledGrant;

export function grantRejected(reason: UploadRejectionReason): RejectedGrant {
  return { outcome: "rejected", reason, message: UPLOAD_REJECTION_MESSAGES[reason] };
}

export function grantThrottled(retryAfterMs: number): ThrottledGrant {
  return { outcome: "throttled", message: UPLOAD_THROTTLED_MESSAGE, retryAfterMs };
}

/* -------------------------------------------------------------------------- */
/* Proving a grant is a grant                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `@partybooth/backend/client-api` *asserts* the shape of every Convex call — it
 * is a hand-written description cast onto `AnyApi`, because offline codegen
 * cannot introspect a deployment that does not exist yet. An assertion is not a
 * check, and the repo's rule (README → "The Convex wire contract") is that
 * anything a client **branches on** gets re-parsed with a real schema at the
 * call site. `parseJoinResult` in `./join` is the precedent; this is its upload
 * twin, and it lives here rather than in either app because both apps branch on
 * the same three outcomes.
 *
 * It fails **closed**: an unrecognised payload throws rather than being treated
 * as a grant, because the next thing that happens to a grant is that bytes get
 * sent somewhere on the strength of it.
 *
 * Every enum below is the one declared above rather than a restatement of it, so
 * this schema describes the *shape* of the result and never a rule about it. A
 * rejection reason added to {@link UPLOAD_REJECTION_REASONS} is accepted by this
 * parser the moment it exists.
 */
const issuedGrantSchema = z.object({
  outcome: z.literal("granted"),
  grantId: z.string().min(1),
  secret: z.string().min(16),
  eventId: z.string().min(1),
  captureId: z.string().min(1),
  mediaType: mediaTypeSchema,
  mediaSource: z.enum(MEDIA_SOURCES),
  storageRegion: storageRegionSchema,
  byteSize: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

const rejectedGrantSchema = z.object({
  outcome: z.literal("rejected"),
  reason: z.enum(UPLOAD_REJECTION_REASONS),
  message: z.string().min(1),
});

const throttledGrantSchema = z.object({
  outcome: z.literal("throttled"),
  message: z.string().min(1),
  retryAfterMs: z.number().int().nonnegative(),
});

export const grantResultSchema = z.discriminatedUnion("outcome", [
  issuedGrantSchema,
  rejectedGrantSchema,
  throttledGrantSchema,
]);

/** Throws on anything that is not one of the three documented outcomes. */
export function parseGrantResult(value: unknown): GrantResult {
  return grantResultSchema.parse(value) as GrantResult;
}

export function isIssuedGrant(result: GrantResult): result is IssuedGrant {
  return result.outcome === "granted";
}

/**
 * Has this grant already run out?
 *
 * Checked by both clients before an upload starts as well as by Convex, because
 * a phone that spent ninety seconds re-encoding a 12-megapixel HEIC can
 * genuinely arrive at the upload with a dead grant, and asking for a fresh one
 * is instant while discovering it from a failed upload is not.
 *
 * The clock is the device's, which is why this is only ever used to *give up
 * early* — never to decide that a grant is still good. {@link GRANT_POLICY}'s
 * TTL is two minutes; a phone whose clock is two minutes fast simply re-requests.
 */
export function grantHasExpired(grant: Pick<IssuedGrant, "expiresAt">, now: number): boolean {
  return now >= grant.expiresAt;
}

/* -------------------------------------------------------------------------- */
/* The upload ticket — the wire between both clients and the route handler     */
/* -------------------------------------------------------------------------- */

/**
 * The **upload ticket**: what a client hands the UploadThing route handler in
 * `apps/web` alongside the bytes, and the only thing that handler knows about an
 * upload before it asks Convex.
 *
 * This lives in `contracts` because it is a wire contract between three
 * packages that do not import one another: `apps/web`'s capture page and
 * `apps/mobile`'s upload queue both build one, and `apps/web`'s
 * `.middleware()` parses it. `apps/mobile` deliberately does not depend on the
 * website's build, so before this moved here the only thing keeping the two
 * sides in step was a comment — and they had already drifted.
 *
 * It is **not a credential**. `secret` is: that is the single-use grant Convex
 * minted, and it is the only field with any authority at all. Everything else is
 * a *claim* the client makes about the file it is sending, and the middleware's
 * job is to check those claims agree with the file actually being offered
 * ({@link checkTicketAgainstFiles}) before it spends a round trip on the grant.
 * The check that actually binds is `matchesGrant` in Convex, where one side of
 * the comparison is a value the server minted and capped.
 */

/**
 * The `FileRouter` key `apps/web` exports and both clients call.
 *
 * One route for all party media, not one per media type: the route's job is to
 * check a grant and hand the bytes on, and the grant already knows whether it
 * was issued for a photo or a video. Splitting it would duplicate the middleware
 * and give Sprint 4 a second place to forget.
 */
export const UPLOAD_ROUTE_SLUG = "partyMedia" as const;

/** Path the route handler is mounted at, appended to the public site origin. */
export const UPLOAD_ROUTE_PATH = "/api/uploadthing";

/**
 * A pixel dimension a client could plausibly report. Bounded because these
 * numbers are unverified claims that end up on a media row — they decide how a
 * thumbnail is laid out and nothing more, but an unbounded integer on a record
 * is still an unbounded integer on a record.
 */
const pixelSchema = z.number().int().positive().max(100_000);

export const uploadTicketSchema = z.object({
  /**
   * The grant secret, verbatim, from `media.requestUploadGrant`.
   *
   * It reaches `onUploadComplete` by riding in the middleware's metadata, which
   * means it makes a round trip through UploadThing rather than staying on our
   * own server. That is a deliberate, bounded exposure: the alternative is
   * per-instance state that a serverless callback landing on a different
   * instance cannot read. What limits it is the grant itself — two minutes,
   * single use, bound to one event, one capture, one exact byte count.
   */
  secret: z.string().min(16).max(512),
  /**
   * Opaque to both clients — Convex owns the id space. It is carried so the
   * handler can put an event on a log line without decoding the grant.
   */
  eventId: z.string().min(1).max(64),
  captureId: captureIdSchema,
  mediaType: mediaTypeSchema,
  /** Byte length of the exact body being sent. Cross-checked against the file. */
  byteSize: z.number().int().positive(),
  mimeType: z.string().min(1).max(128),
  /** Lower-case hex SHA-256 of the same bytes, computed after re-encoding. */
  checksum: checksumSchema,
  width: pixelSchema.optional(),
  height: pixelSchema.optional(),
  durationSeconds: z
    .number()
    .positive()
    .max(24 * 60 * 60)
    .optional(),
});

export type UploadTicket = z.infer<typeof uploadTicketSchema>;

/**
 * Facts about the body a client is about to send. Everything a ticket needs that
 * the grant does not already carry.
 */
export interface UploadTicketFile {
  readonly mimeType: string;
  readonly checksum: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationSeconds?: number | undefined;
}

/**
 * Build the ticket for an issued grant.
 *
 * Both clients call this rather than assembling the object themselves, which is
 * the point: `eventId`, `captureId`, `mediaType` and `byteSize` are taken from
 * the **grant**, not from the caller's own copy of them, so a client whose local
 * state has drifted from what it was granted produces a ticket the middleware
 * rejects instead of one that quietly describes a different file.
 */
export function buildUploadTicket(grant: IssuedGrant, file: UploadTicketFile): UploadTicket {
  return {
    secret: grant.secret,
    eventId: grant.eventId,
    captureId: grant.captureId,
    mediaType: grant.mediaType,
    byteSize: grant.byteSize,
    mimeType: file.mimeType,
    checksum: file.checksum,
    ...(file.width === undefined ? {} : { width: file.width }),
    ...(file.height === undefined ? {} : { height: file.height }),
    ...(file.durationSeconds === undefined ? {} : { durationSeconds: file.durationSeconds }),
  };
}

/**
 * What UploadThing tells the middleware about the file a client is offering.
 * Structurally the `File` fields the SDK forwards, narrowed to the two checked.
 */
export interface OfferedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export type TicketMismatch = "fileCount" | "byteSize" | "mimeType";

export const TICKET_MISMATCH_MESSAGES: Record<TicketMismatch, string> = {
  fileCount: "Send one photo at a time.",
  byteSize: "That file is not the one this upload was authorised for.",
  mimeType: "That file is not the type this upload was authorised for.",
};

export type TicketCheck = { ok: true } | { ok: false; reason: TicketMismatch; message: string };

/**
 * Does the file being offered match the ticket describing it?
 *
 * This is a **cheap edge check, not the binding**. Both sides of every
 * comparison here originate on the client, so a caller willing to lie
 * consistently passes it; what stops that caller is `matchesGrant` in Convex.
 *
 * It earns its place by failing fast and locally: a mismatched ticket is refused
 * before an upload URL is minted, before bytes cross a party's wifi, and before
 * an object exists in private storage that somebody then has to delete.
 *
 * The single-file rule is not a limitation either — an upload grant names one
 * `captureId`, so a second file in the same request has no grant to be checked
 * against and could only ever be stored unattributed.
 */
export function checkTicketAgainstFiles(
  ticket: Pick<UploadTicket, "byteSize" | "mimeType">,
  files: readonly OfferedFile[],
): TicketCheck {
  const file = files.length === 1 ? files[0] : undefined;
  if (file === undefined) return ticketFail("fileCount");
  if (file.size !== ticket.byteSize) return ticketFail("byteSize");
  // Compared case-insensitively and without parameters: clients disagree about
  // `image/jpeg` vs `image/jpeg; charset=…` and about the case of the subtype,
  // and neither difference is the substitution this check exists to catch.
  if (normaliseMime(file.type) !== normaliseMime(ticket.mimeType)) return ticketFail("mimeType");
  return { ok: true };
}

function ticketFail(reason: TicketMismatch): TicketCheck {
  return { ok: false, reason, message: TICKET_MISMATCH_MESSAGES[reason] };
}

export function normaliseMime(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Completion outcomes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What happened when a completed upload was registered.
 *
 * The interesting values are the boring ones. `duplicate` is a callback we have
 * already handled — the provider retries, and a retry must change nothing.
 * `discarded` is a callback that arrived for a capture whose media row is
 * already `deleted`: the bytes are real, nobody may ever see them, so the file
 * is deleted rather than attached. Both are **successes** from the caller's
 * point of view, because a callback that returns an error gets retried forever.
 */
export const UPLOAD_COMPLETION_OUTCOMES = [
  "registered",
  "duplicate",
  "discarded",
  "rejected",
] as const;

export type UploadCompletionOutcome = (typeof UPLOAD_COMPLETION_OUTCOMES)[number];

export type UploadCompletionRejection =
  "unknownGrant" | "expired" | "alreadyConsumed" | GrantMismatchReason;

/**
 * Widen a file-validation reason to an upload rejection reason.
 *
 * The body is the identity function and that is the entire point: it compiles
 * only while every `MediaRejectionReason` is also an `UploadRejectionReason`, so
 * adding a rejection to `media.ts` without listing it above is a type error
 * here rather than a `default:` branch that silently reports the wrong thing.
 */
export function uploadReasonForFile(reason: MediaRejectionReason): UploadRejectionReason {
  return reason;
}
