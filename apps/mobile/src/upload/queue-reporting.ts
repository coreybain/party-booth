/**
 * Telling the server what the durable queue did.
 *
 * The server genuinely cannot see this. An upload that never reaches storage
 * produces no provider callback, no media row and no consumed grant — so the
 * only witness to "your photo did not send" is the phone that gave up, and the
 * only witness to "it went through in the end" is the same phone an hour later
 * when the wifi came back. That is why `push.reportUploadQueue` exists and why
 * this module has to decide *when* to call it.
 *
 * ## What counts as a failure
 *
 * Not "an attempt failed" — attempts fail all evening on party wifi and the
 * queue is built to shrug them off. A failure worth a notification is a capture
 * the engine has **stopped working on**: either the refusal was permanent (the
 * party is over, the file is too big, the capture was withdrawn) or the
 * automatic retries are spent. Anything looser and a guest gets buzzed about a
 * photo that arrives ten seconds later, which teaches them to ignore the next
 * one.
 *
 * ## What counts as a recovery
 *
 * Reaching `uploaded` **after** a failure was reported. A bare "sent" is noise;
 * the same words after "didn't send" are the reassurance the pair exists for.
 * The backend enforces the same pairing independently (`shouldNotifyUploadQueue`
 * reads a mark on the throttle row), so a client that reported a recovery it
 * never earned buzzes nobody.
 *
 * Pure, so the whole rule is a unit test: no React, no Convex, no clock.
 */

import { MAX_AUTO_ATTEMPTS } from "./queue-reducer";

import type { UploadQueueEvent } from "@partybooth/contracts/push";
import type { QueueItem } from "./types";

export interface QueueReport {
  readonly eventId: string;
  readonly captureId: string;
  readonly event: UploadQueueEvent;
  readonly attempts: number;
}

/**
 * Has the engine given up on this capture?
 *
 * The same two conditions `nextRunnable` uses to *stop* picking an item up,
 * stated from the other side. They are deliberately read off the item rather
 * than duplicated as a flag: a flag is a second source of truth that gets
 * written in one of the three places a failure can be recorded and not the other
 * two.
 */
export function hasGivenUp(item: QueueItem): boolean {
  if (item.state !== "failed") return false;
  if (item.failure?.permanent === true) return true;
  return item.attempts >= MAX_AUTO_ATTEMPTS;
}

/**
 * Which reports are owed, given the queue and what has already been reported.
 *
 * `reported` is the set of `captureId`s a `failed` report has been sent for and
 * not yet recovered. The caller owns it: add on `failed`, delete on `recovered`.
 * Keeping it outside means this function is a pure `(state) → actions` and the
 * bookkeeping is one line at the call site rather than a mutable field in here.
 *
 * A capture that is `cancelled` — undone, or abandoned by the guest — is
 * deliberately **not** recovered *or* re-reported. They know: they pressed the
 * button. It is dropped from the set so the row can be forgotten.
 */
export function queueReportsFor(
  items: readonly QueueItem[],
  reported: ReadonlySet<string>,
): readonly QueueReport[] {
  const reports: QueueReport[] = [];

  for (const item of items) {
    const known = reported.has(item.captureId);

    if (!known && hasGivenUp(item)) {
      reports.push({
        eventId: item.eventId,
        captureId: item.captureId,
        event: "failed",
        attempts: item.attempts,
      });
      continue;
    }

    if (known && item.state === "uploaded") {
      reports.push({
        eventId: item.eventId,
        captureId: item.captureId,
        event: "recovered",
        attempts: item.attempts,
      });
    }
  }

  return reports;
}

/**
 * The set after a batch of reports has been sent.
 *
 * Returned rather than mutated so the caller can apply it in one assignment and
 * a test can assert on it directly. A capture that has vanished from the queue
 * entirely — swept after its retention window — is dropped too, so the set
 * cannot grow for the length of a party.
 */
export function nextReportedSet(
  current: ReadonlySet<string>,
  sent: readonly QueueReport[],
  items: readonly QueueItem[],
): Set<string> {
  const live = new Set(items.map((item) => item.captureId));
  const next = new Set([...current].filter((captureId) => live.has(captureId)));

  for (const report of sent) {
    if (report.event === "failed") next.add(report.captureId);
    else next.delete(report.captureId);
  }
  return next;
}
