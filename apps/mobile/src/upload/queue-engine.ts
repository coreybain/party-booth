/**
 * The decisions the upload engine makes, extracted from the effects it performs.
 *
 * `./queue-provider` owns the promises, the timers and the Convex mutations.
 * What is here is everything that can be answered with numbers: which item goes
 * next, whether the ticker needs to be running at all, and what a failure means.
 * That split is what lets "does a throttled grant back off by the amount the
 * server asked for?" be a unit test rather than a party.
 *
 * No React Native imports — unit-tested in plain Node.
 */

import {
  isPermanentRejection,
  UPLOAD_REJECTION_MESSAGES,
  type GrantResult,
  type IssuedGrant,
} from "@partybooth/contracts/upload";

import { derivativesSettled, MAX_AUTO_ATTEMPTS, nextDerivative } from "./queue-reducer";
import {
  isTerminalCapture,
  type QueueDerivative,
  type QueueFailure,
  type QueueItem,
} from "./types";

/* -------------------------------------------------------------------------- */
/* What to run next                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The next item the engine should attempt, or `undefined` when there is nothing
 * to do right now.
 *
 * Oldest first, which is the opposite of how the list is drawn and is correct:
 * the queue is a queue. A guest photographing the cake being cut expects the
 * first shot to reach the host first, and on party wifi the difference is
 * visible.
 *
 * `failed` items are picked up here too — the reducer parks them with a
 * `nextAttemptAt` in the future, so "has the backoff matured?" and "is it my
 * turn?" are the same question.
 */
export function nextRunnable(items: readonly QueueItem[], now: number): QueueItem | undefined {
  return [...items]
    .filter((item) => isRunnable(item, now))
    .sort((a, b) => a.capturedAt - b.capturedAt)[0];
}

function isRunnable(item: QueueItem, now: number): boolean {
  if (item.nextAttemptAt > now) return false;
  if (item.state === "queued") return true;
  if (item.state !== "failed") return false;
  // A failure the server told us not to retry is not retried on a timer. The
  // Photos tab still offers a button; a human deciding to try again is a
  // different thing from a phone deciding it for them.
  if (item.failure?.permanent === true) return false;
  return item.attempts < MAX_AUTO_ATTEMPTS;
}

/* -------------------------------------------------------------------------- */
/* Tasks — originals and derivatives                                          */
/* -------------------------------------------------------------------------- */

/**
 * One unit of work. Two kinds, one loop, one concurrency budget of 1.
 *
 * A derivative could have been given its own pump, and that would have been
 * worse: two loops share one saturated access point and one battery, and the
 * ordering between "the host can see the photograph" and "the thumbnail is a bit
 * smaller" would then be up to the scheduler rather than to us.
 */
export type QueueTask =
  | { readonly kind: "original"; readonly item: QueueItem }
  | {
      readonly kind: "derivative";
      readonly item: QueueItem;
      readonly derivative: QueueDerivative;
    };

/**
 * What the engine should attempt next, or `undefined` when there is nothing.
 *
 * **Originals always win.** Every capture that is still waiting to reach the
 * party goes before any thumbnail does, however old the thumbnail is. That is
 * the right priority because a first-party original is served to everybody —
 * `sourceMetadataStripped` is `true` on every capture this app produces — so a
 * derivative that has not arrived yet costs a fellow guest a larger image, and a
 * *capture* that has not arrived yet costs the host the photograph.
 *
 * Within each kind it is oldest-first, for the reason `nextRunnable` already
 * gives: the queue is a queue, and at a party the order is visible.
 */
export function nextTask(items: readonly QueueItem[], now: number): QueueTask | undefined {
  const original = nextRunnable(items, now);
  if (original !== undefined) return { kind: "original", item: original };

  const ordered = [...items].sort((a, b) => a.capturedAt - b.capturedAt);
  for (const item of ordered) {
    const derivative = nextDerivative(item, now);
    if (derivative !== undefined) return { kind: "derivative", item, derivative };
  }
  return undefined;
}

/**
 * When the engine next has something to do, or `null` if it can go quiet.
 *
 * Used to decide whether a timer runs at all. A phone whose queue is empty (the
 * normal state) must not hold a 250 ms interval open all evening, and a phone
 * with one item backing off for two minutes should not wake up 480 times to find
 * out it is not ready.
 */
export function nextWakeUpAt(items: readonly QueueItem[], now: number): number | null {
  let soonest: number | null = null;
  for (const item of items) {
    const at = wakeUpAtFor(item, now);
    if (at === null) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

function wakeUpAtFor(item: QueueItem, now: number): number | null {
  // A capture inside its undo window wakes the engine when the window shuts.
  // One that is waiting on a human never does — there is no deadline to keep.
  if (item.state === "captured") return item.autoSend ? item.sendAt : null;
  if (item.state === "queued") return Math.max(item.nextAttemptAt, now);
  if (item.state === "failed" && isRunnable({ ...item, nextAttemptAt: 0 }, now)) {
    return item.nextAttemptAt;
  }
  // An `uploaded` capture is finished as far as the guest is concerned and still
  // owes the party its preview. Without this the derivative would sit until some
  // *other* capture happened to wake the loop — which at the end of a party is
  // never, and the last few photographs would ship without thumbnails.
  if (item.state === "uploaded") {
    const soonest = item.derivatives
      .filter((derivative) => derivative.state === "pending")
      .map((derivative) => Math.max(derivative.nextAttemptAt, now));
    return soonest.length === 0 ? null : Math.min(...soonest);
  }
  return null;
}

/**
 * Anything at all that still needs watching, for the tab badge and the ticker.
 *
 * Includes an uploaded capture with an unsent derivative: the engine has work,
 * so the ticker must keep running. It is deliberately **not** what
 * `pendingCountForEvent` counts — the badge on the camera says "3 sending" about
 * photographs, and a guest does not think of a thumbnail as a photograph.
 */
export function hasPendingWork(items: readonly QueueItem[]): boolean {
  return items.some((item) => !isTerminalCapture(item.state) || !derivativesSettled(item));
}

/* -------------------------------------------------------------------------- */
/* Reading a refusal                                                          */
/* -------------------------------------------------------------------------- */

/*
 * Which refusals a later attempt cannot fix is `@partybooth/contracts/upload`'s
 * call, not this file's. `apps/web` asks the same function, so the same photo
 * gets the same fate whichever client the guest is holding — and the one that
 * matters at a real party, `eventNotAcceptingUploads`, stays retryable in both,
 * because a host who pauses the queue to catch up on moderation un-pauses two
 * minutes later.
 */
export { isPermanentRejection };

/** What the engine should do next, given the answer to a grant request. */
export type GrantOutcome =
  | { readonly kind: "granted"; readonly grant: IssuedGrant }
  | {
      readonly kind: "failed";
      readonly failure: QueueFailure;
      readonly retryAfterMs?: number | undefined;
    };

/**
 * Translate `media.requestUploadGrant`'s three-way answer into a queue decision.
 *
 * The backend returns refusals as **values** rather than exceptions (a Convex
 * mutation that throws rolls its own throttle write back — see ADR 0004), so
 * this is the one place the client has to fan them back out. Messages come from
 * the contract, not from here: they are already written for a guest and are the
 * same words `apps/web` shows.
 */
export function readGrantResult(result: GrantResult): GrantOutcome {
  if (result.outcome === "granted") return { kind: "granted", grant: result };

  if (result.outcome === "throttled") {
    return {
      kind: "failed",
      failure: { message: result.message, permanent: false },
      retryAfterMs: result.retryAfterMs,
    };
  }

  return {
    kind: "failed",
    failure: {
      message: result.message || UPLOAD_REJECTION_MESSAGES[result.reason],
      permanent: isPermanentRejection(result.reason),
    },
  };
}
