import { z } from "zod";

/**
 * Push notifications — the parts that are the same on every side of the wire.
 *
 * Three audiences share this module and none of them may disagree: `apps/mobile`
 * decides which toggle to render and what token to send up, `packages/backend`
 * decides whether a given ping is wanted and how to talk to Expo, and the tests
 * pin the arithmetic. Everything here is **pure** — the HTTP call itself lives
 * behind an adapter in `packages/backend/convex/lib/push/`, so a unit test never
 * needs a network and a deployment with no Expo project simply does not send.
 *
 * The Expo constants below are transcribed from
 * <https://docs.expo.dev/push-notifications/sending-notifications/> (checked
 * 28 Jul 2026) and are the ones the real adapter is built against.
 */

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The notifications PartyBooth sends, which is exactly the list in PLAN.md:
 * "upload failure/recovery, event open/close, pending-queue threshold for
 * hosts".
 *
 * A category is the unit of **opt-out**, so the split is by what a person would
 * turn off rather than by what the code finds convenient to emit. "My upload
 * failed" and "…and then it worked" are one decision, so they are one category:
 * nobody wants to be told about the failure and not the recovery.
 */
export const PUSH_CATEGORIES = [
  /** Your own upload failed after its retries, and later, that it recovered. */
  "uploadStatus",
  /** A party you are in opened or closed. */
  "eventLifecycle",
  /** You are a host and the moderation queue has built up. */
  "hostPendingThreshold",
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const pushCategorySchema = z.enum(PUSH_CATEGORIES);

export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === "string" && (PUSH_CATEGORIES as readonly string[]).includes(value);
}

/** The label and explanation a settings screen renders for each toggle. */
export const PUSH_CATEGORY_COPY: Record<PushCategory, { title: string; description: string }> = {
  uploadStatus: {
    title: "Upload problems",
    description: "When a photo or video of yours fails to send — and when it goes through.",
  },
  eventLifecycle: {
    title: "Party opened or closed",
    description: "When a host opens a party you are in, or brings it to a close.",
  },
  hostPendingThreshold: {
    title: "Photos waiting for you",
    description: "When you are hosting and the moderation queue builds up.",
  },
};

/**
 * Which categories a host-only notification belongs to.
 *
 * A guest never receives `hostPendingThreshold`, so the preference is rendered
 * only for someone who hosts something. It is still *stored* for everybody —
 * a guest who becomes a co-host tomorrow should not silently inherit "on"
 * because nobody asked them.
 */
export const HOST_ONLY_PUSH_CATEGORIES = [
  "hostPendingThreshold",
] as const satisfies readonly PushCategory[];

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Preferences are stored as the categories a user has switched **off**.
 *
 * An opt-out list rather than a per-category boolean map, for one reason that
 * matters at launch and again at every release afterwards: adding a category
 * must not require a migration, and it must default to *on* for accounts that
 * have never seen the toggle. An absent list means "everything is on", which is
 * what every row stored before this shipped means, so nothing changes meaning.
 */
export const notificationPreferencesSchema = z.object({
  /** Categories explicitly switched off. Absent or empty means everything is on. */
  optOut: z.array(pushCategorySchema).max(PUSH_CATEGORIES.length).default([]),
  /**
   * How many pending items it takes before a host is pinged. Per-user because a
   * host running a fifty-guest party and one running a dinner want different
   * numbers, and neither wants the other's.
   */
  pendingThreshold: z
    .number()
    .int()
    .min(1, { error: "Pick at least 1." })
    .max(100, { error: "That is more than a host will ever work through in one sitting." })
    .optional(),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** PLAN.md's default for the host pending-queue ping. */
export const DEFAULT_PENDING_THRESHOLD = 5;

export interface StoredPreferences {
  optOut?: readonly PushCategory[] | undefined;
  pendingThreshold?: number | undefined;
}

/** Does this account want this category? Absent preferences mean yes. */
export function wantsPushCategory(
  preferences: StoredPreferences | undefined,
  category: PushCategory,
): boolean {
  return !(preferences?.optOut ?? []).includes(category);
}

/** The threshold to use, clamped to the schema's bounds. */
export function pendingThresholdOf(preferences: StoredPreferences | undefined): number {
  const raw = preferences?.pendingThreshold;
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PENDING_THRESHOLD;
  return Math.min(100, Math.max(1, Math.trunc(raw)));
}

/* -------------------------------------------------------------------------- */
/* Debounce                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long a category stays quiet after it has fired, per user and per subject.
 *
 * The requirement is "debounced so a burst sends one ping": thirty guests each
 * sending a photo in the same minute is one event in the host's life, not
 * thirty. The window is generous because the cost of a late second ping is
 * nothing and the cost of a phone buzzing thirty times is a host who turns
 * notifications off.
 */
export const PUSH_DEBOUNCE_MS: Record<PushCategory, number> = {
  uploadStatus: 60_000,
  eventLifecycle: 60_000,
  hostPendingThreshold: 10 * 60_000,
};

/**
 * The debounce state a caller keeps for one `(user, subject, category)` triple.
 * Persisted by the backend in `notificationThrottles`; pure here so the rule is
 * testable without a database.
 */
export interface PushDebounceState {
  lastSentAt?: number | undefined;
  /** Category-specific memory. The pending ping stores the count it fired at. */
  lastValue?: number | undefined;
}

export interface PendingThresholdInput {
  /** How many items are waiting for a host right now. */
  pending: number;
  threshold: number;
  state: PushDebounceState | undefined;
  now: number;
  debounceMs?: number | undefined;
}

export type PendingThresholdDecision =
  | { notify: true }
  /** Below the line: the caller **clears** the state so the next crossing fires. */
  | { notify: false; reason: "belowThreshold"; clear: true }
  | { notify: false; reason: "debounced"; clear: false };

/**
 * Should a host be pinged about their pending queue?
 *
 * Two rules, and the second is the one that makes a burst one ping:
 *
 * 1. Below the threshold, never — and the memory is **cleared**, so a queue that
 *    drains and fills again pings immediately rather than waiting out a window
 *    that started during the last rush.
 * 2. At or above it, once, then not again until `debounceMs` has passed. Thirty
 *    photos landing in one minute cross the line once and buzz once.
 */
export function shouldNotifyPendingThreshold(
  input: PendingThresholdInput,
): PendingThresholdDecision {
  if (input.pending < input.threshold) {
    return { notify: false, reason: "belowThreshold", clear: true };
  }
  const lastSentAt = input.state?.lastSentAt;
  if (lastSentAt === undefined) return { notify: true };

  const window = input.debounceMs ?? PUSH_DEBOUNCE_MS.hostPendingThreshold;
  return input.now - lastSentAt >= window
    ? { notify: true }
    : { notify: false, reason: "debounced", clear: false };
}

/**
 * Should a plain debounced category fire?
 *
 * Used by the event open/close ping, where the subject is the event and the
 * only question is "have we just said this".
 */
export function shouldNotifyDebounced(
  category: PushCategory,
  state: PushDebounceState | undefined,
  now: number,
  debounceMs?: number,
): boolean {
  const lastSentAt = state?.lastSentAt;
  if (lastSentAt === undefined) return true;
  return now - lastSentAt >= (debounceMs ?? PUSH_DEBOUNCE_MS[category]);
}

/* -------------------------------------------------------------------------- */
/* Upload status                                                              */
/* -------------------------------------------------------------------------- */

export const UPLOAD_QUEUE_EVENTS = ["failed", "recovered"] as const;
export type UploadQueueEvent = (typeof UPLOAD_QUEUE_EVENTS)[number];
export const uploadQueueEventSchema = z.enum(UPLOAD_QUEUE_EVENTS);

/**
 * A client telling the server what happened to one item in its durable queue.
 *
 * `captureId` rather than a media id because the whole point of the failure case
 * is that no media row exists — the upload never landed. It is the same id the
 * grant was minted against, so the two halves of the story join up afterwards.
 */
export const reportUploadQueueInputSchema = z.object({
  eventId: z.string().min(1),
  captureId: z.string().trim().min(8).max(64),
  event: uploadQueueEventSchema,
  /** How many attempts the client had made. Metadata only. */
  attempts: z.number().int().nonnegative().max(1000).optional(),
});
export type ReportUploadQueueInput = z.infer<typeof reportUploadQueueInputSchema>;

/**
 * Whether a queue report is worth a notification.
 *
 * A recovery is only interesting to somebody who was told about the failure —
 * "your photo sent" is noise on its own, and it is *reassurance* after "your
 * photo did not send". So the recovery ping is conditional on the failure ping
 * having fired for the same capture, which is what `lastValue` records.
 */
export const UPLOAD_QUEUE_FAILED_MARK = 1;

export function shouldNotifyUploadQueue(
  event: UploadQueueEvent,
  state: PushDebounceState | undefined,
): boolean {
  if (event === "failed") return state?.lastValue !== UPLOAD_QUEUE_FAILED_MARK;
  return state?.lastValue === UPLOAD_QUEUE_FAILED_MARK;
}

/* -------------------------------------------------------------------------- */
/* Message copy                                                               */
/* -------------------------------------------------------------------------- */

export interface PushMessageBody {
  title: string;
  body: string;
}

export function uploadFailedMessage(eventName: string): PushMessageBody {
  return {
    title: "Your upload didn't send",
    body: `We couldn't send one of your photos to ${eventName}. Open PartyBooth to retry it.`,
  };
}

export function uploadRecoveredMessage(eventName: string): PushMessageBody {
  return {
    title: "Sent after all",
    body: `That photo made it through to ${eventName}.`,
  };
}

export function eventOpenedMessage(eventName: string): PushMessageBody {
  return { title: `${eventName} is live`, body: "The party is open — start taking photos." };
}

export function eventClosedMessage(eventName: string): PushMessageBody {
  return {
    title: `${eventName} has wrapped up`,
    body: "No more photos for now. The gallery stays open.",
  };
}

export function pendingThresholdMessage(eventName: string, pending: number): PushMessageBody {
  return {
    title: `${pending} photos waiting`,
    body: `${eventName} has ${pending} submissions to review.`,
  };
}

/* -------------------------------------------------------------------------- */
/* The routing payload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The `data` bag a notification carries, which is how a tap knows where to go.
 *
 * This is the one piece of the push system that is written by one codebase and
 * read by another across a network and a JSON round trip: `packages/backend`
 * builds it in `convex/lib/notifications.ts`, Expo passes it through untouched,
 * and `apps/mobile` turns it back into a route. Two restatements of it drifted
 * apart once already — the builders were string literals in the backend and the
 * parser had its own hand-copied list of kinds — so both halves are here now and
 * neither app spells a key.
 *
 * `kind` **is** the {@link PushCategory}, deliberately: the thing a person opted
 * out of and the thing a tap opens are the same thing, and a second parallel
 * enum would be one more table to keep in step for no gain.
 */
export type PushPayloadKind = PushCategory;

/** Which way an event's lifecycle moved. Written by the backend, read by the tap. */
export const LIFECYCLE_TRANSITIONS = ["opened", "closed"] as const;
export type LifecycleTransition = (typeof LIFECYCLE_TRANSITIONS)[number];

/**
 * A parsed payload.
 *
 * Every field but `kind` is nullable because the sender may be an older or newer
 * deployment than the build reading it. A missing field is never an error — it
 * degrades to "open the app and change nothing", which is what a notification
 * did before any of this existed.
 */
export interface PushPayload {
  readonly kind: PushPayloadKind;
  readonly eventId: string | null;
  readonly transition: string | null;
  readonly captureId: string | null;
}

/**
 * The wire form. Expo's `data` is a string map, so everything is stringified
 * here rather than at each call site.
 */
export type PushPayloadWire = Record<string, string>;

export function uploadStatusPayload(
  eventId: string,
  captureId: string,
  transition: UploadQueueEvent,
): PushPayloadWire {
  return { kind: "uploadStatus", eventId, captureId, transition };
}

export function eventLifecyclePayload(
  eventId: string,
  transition: LifecycleTransition,
): PushPayloadWire {
  return { kind: "eventLifecycle", eventId, transition };
}

export function pendingThresholdPayload(eventId: string): PushPayloadWire {
  return { kind: "hostPendingThreshold", eventId };
}

function readPayloadString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a notification's `data` bag, or `null` if it is not one of ours.
 *
 * Nothing is assumed. An unknown `kind`, a payload that is not an object, or a
 * bag from a deployment this build predates all produce `null`.
 */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;

  const kind = readPayloadString(record, "kind");
  if (kind === null || !isPushCategory(kind)) return null;

  return {
    kind,
    eventId: readPayloadString(record, "eventId"),
    transition: readPayloadString(record, "transition"),
    captureId: readPayloadString(record, "captureId"),
  };
}

/* -------------------------------------------------------------------------- */
/* Expo push tokens                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `ExponentPushToken[…]` — and `ExpoPushToken[…]`, which the SDK also emits.
 *
 * Validated rather than accepted as any string so a device that registers
 * something else (an FCM token, an empty string, a placeholder from a simulator)
 * is refused at the door rather than sitting in the table failing forever.
 */
export const EXPO_PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,128}\]$/;

export const expoPushTokenSchema = z
  .string()
  .trim()
  .max(256)
  .regex(EXPO_PUSH_TOKEN_PATTERN, { error: "That is not an Expo push token." });

export function isExpoPushToken(value: unknown): boolean {
  return typeof value === "string" && EXPO_PUSH_TOKEN_PATTERN.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/* The Expo push service                                                      */
/* -------------------------------------------------------------------------- */

/** <https://docs.expo.dev/push-notifications/sending-notifications/> */
export const EXPO_PUSH_SEND_ENDPOINT = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo refuses more than this many messages in one send request. */
export const EXPO_PUSH_SEND_CHUNK_SIZE = 100;
/** …and more than this many ids in one receipts request. */
export const EXPO_PUSH_RECEIPT_CHUNK_SIZE = 1000;
/** Total serialised size of one notification. */
export const EXPO_PUSH_MAX_PAYLOAD_BYTES = 4096;

/**
 * How long to wait before asking for receipts.
 *
 * Expo's own guidance is fifteen minutes, and receipts are discarded after
 * twenty-four hours — so this is a floor with an enormous ceiling, and the
 * scheduled check is allowed to be late.
 */
export const PUSH_RECEIPT_DELAY_MS = 15 * 60_000;

/** Consecutive delivery failures before a token is switched off. */
export const PUSH_FAILURE_LIMIT = 3;

/**
 * A message as the Expo service wants it. Deliberately a subset: PartyBooth
 * sends a title, a body and a small routing payload, and nothing else.
 */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string> | undefined;
  sound?: "default" | null | undefined;
  /** iOS badge. Set for the host queue ping, where a number is the message. */
  badge?: number | undefined;
  channelId?: string | undefined;
}

export type ExpoPushErrorCode =
  | "DeviceNotRegistered"
  | "MessageTooBig"
  | "MessageRateExceeded"
  | "MismatchSenderId"
  | "InvalidCredentials"
  /** An APNs key or provisioning profile problem. Also the project's, not the phone's. */
  | "InvalidProviderToken";

export type ExpoPushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: ExpoPushErrorCode } | undefined };

export type ExpoPushReceipt =
  | { status: "ok" }
  | { status: "error"; message: string; details?: { error?: ExpoPushErrorCode } | undefined };

/**
 * Errors that mean **this token is dead** rather than "this send went wrong".
 *
 * Only `DeviceNotRegistered`, and the narrowness is the point. Expo's docs are
 * explicit that it means "stop sending messages to the corresponding Expo push
 * token"; the other four describe the *project's* credentials or the message's
 * size, and pruning a device because the server has the wrong APNs key would
 * quietly empty the table on the day somebody rotates a certificate.
 */
export const PUSH_TOKEN_INVALIDATING_ERRORS = [
  "DeviceNotRegistered",
] as const satisfies readonly ExpoPushErrorCode[];

export function shouldPruneToken(code: string | undefined): boolean {
  return code !== undefined && (PUSH_TOKEN_INVALIDATING_ERRORS as readonly string[]).includes(code);
}

/**
 * Errors worth retrying later rather than counting against the device.
 *
 * `MessageRateExceeded` is the project being throttled — Expo's advice is
 * exponential backoff — and it says nothing at all about the phone.
 */
export function isRetryablePushError(code: string | undefined): boolean {
  return code === "MessageRateExceeded";
}

/**
 * Errors that are the **project's** problem rather than the phone's.
 *
 * A revoked APNs key, an FCM sender mismatch or a bad provisioning profile fail
 * for *every* device at once and say nothing about any of them. They must not
 * count against a device's failure budget, because otherwise the third send
 * after somebody rotates a certificate disables the entire table — which is the
 * same outcome {@link PUSH_TOKEN_INVALIDATING_ERRORS} is deliberately narrow to
 * avoid, reached three sends later instead of immediately.
 */
export const PUSH_PROJECT_CREDENTIAL_ERRORS = [
  "MismatchSenderId",
  "InvalidCredentials",
  "InvalidProviderToken",
] as const satisfies readonly ExpoPushErrorCode[];

export function isProjectCredentialError(code: string | undefined): boolean {
  return code !== undefined && (PUSH_PROJECT_CREDENTIAL_ERRORS as readonly string[]).includes(code);
}

/** Split a list into request-sized batches. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be positive");
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** Does this message fit inside Expo's payload ceiling? */
export function fitsPushPayload(message: ExpoPushMessage): boolean {
  return JSON.stringify(message).length <= EXPO_PUSH_MAX_PAYLOAD_BYTES;
}

/**
 * Trim a message until it fits.
 *
 * Truncating the body is strictly better than dropping the notification: the
 * title carries the meaning and the body is context, and a `MessageTooBig`
 * receipt arrives fifteen minutes later with nothing to do about it.
 */
export function truncateToPayload(message: ExpoPushMessage): ExpoPushMessage {
  if (fitsPushPayload(message)) return message;
  const overhead = JSON.stringify({ ...message, body: "" }).length;
  const room = Math.max(0, EXPO_PUSH_MAX_PAYLOAD_BYTES - overhead - 1);
  return { ...message, body: message.body.slice(0, room) };
}

/* -------------------------------------------------------------------------- */
/* Dispatch bookkeeping                                                       */
/* -------------------------------------------------------------------------- */

export const PUSH_DELIVERY_STATES = ["queued", "sent", "delivered", "failed", "dropped"] as const;
export type PushDeliveryState = (typeof PUSH_DELIVERY_STATES)[number];
export const pushDeliveryStateSchema = z.enum(PUSH_DELIVERY_STATES);

export const PUSH_PLATFORM_CHANNEL = "default";

/**
 * Update a device's failure counter and decide whether it stays enabled.
 *
 * A pruning error kills the token outright; anything else is counted, and
 * {@link PUSH_FAILURE_LIMIT} consecutive counts do the same thing more slowly.
 * A success resets the counter, so a phone that was in a tunnel is not disabled
 * a week later by three failures spread across a month.
 */
export function nextDeviceHealth(
  current: { failureCount: number; disabledAt?: number | undefined },
  outcome: { ok: boolean; errorCode?: string | undefined; now: number },
): { failureCount: number; disabledAt: number | undefined } {
  if (outcome.ok) return { failureCount: 0, disabledAt: undefined };
  if (shouldPruneToken(outcome.errorCode)) {
    return { failureCount: current.failureCount + 1, disabledAt: outcome.now };
  }
  // A rate limit is the project being throttled and a credential error is the
  // project being misconfigured. Neither is evidence about this phone, so
  // neither is charged to it.
  if (isRetryablePushError(outcome.errorCode) || isProjectCredentialError(outcome.errorCode)) {
    return { failureCount: current.failureCount, disabledAt: current.disabledAt };
  }
  const failureCount = current.failureCount + 1;
  return {
    failureCount,
    disabledAt: failureCount >= PUSH_FAILURE_LIMIT ? outcome.now : current.disabledAt,
  };
}
