import { REPORT_REASONS, REPORT_STATUSES, type ReportReason, type ReportStatus } from "./media";

/**
 * Human-facing strings and formatters that more than one client shows.
 *
 * The bar for putting copy here is **not** "two surfaces say something similar".
 * It is "two surfaces say the same thing, and if they ever stopped saying the
 * same thing that would be a bug". A report category is on that list: a guest
 * picks `notMyPhoto` on their phone and a host reads it on a laptop, and if the
 * two apps disagree about what that value *means* then the host is moderating
 * against a different question from the one the guest answered.
 *
 * What is deliberately **not** unified is *register*. A guest choosing from a
 * list and a host triaging a queue want different sentences for the same enum
 * member, which is why there are two maps below rather than one. They are two
 * maps in one file so the difference between them is visible and intentional,
 * instead of two files that drift and nobody notices.
 *
 * Everything here is pure and platform-free — no React, no DOM, no
 * `Intl`-dependent formatting whose output changes with a device locale, because
 * these strings end up in snapshot assertions on both clients.
 */

/* -------------------------------------------------------------------------- */
/* Content reports                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The **host's** register: a category, not an accusation.
 *
 * A host looking at a reported photo needs to know which bucket it was put in
 * and then look at the picture. The fewer adjectives between them and it, the
 * better — they are about to make a decision about a guest at their own party.
 *
 * Typed as a total `Record` so adding a member to `REPORT_REASONS` is a compile
 * error here rather than a missing row in somebody's queue.
 */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  nudityOrSexual: "Nudity or sexual content",
  violenceOrGore: "Violence or gore",
  hateOrHarassment: "Hate or harassment",
  illegalOrDangerous: "Illegal or dangerous",
  notMyPhoto: "I'm in this and did not agree to it",
  other: "Something else",
};

export interface ReportReasonPrompt {
  /** The tappable line. */
  readonly label: string;
  /** One sentence under it, so nobody has to guess what the category covers. */
  readonly detail: string;
}

/**
 * The **guest's** register: what each reason means when you are the one picking.
 *
 * Phrased second person and without jargon. A guest reporting something at a
 * party is embarrassed and in a hurry, and a category they have to decode is a
 * report that does not get made.
 *
 * `notMyPhoto` is the one that reads most differently from the host's version,
 * and that is the point: to the host it is a claim about consent to triage; to
 * the guest it is "this is me, and I want it taken down".
 */
export const REPORT_REASON_PROMPTS: Readonly<Record<ReportReason, ReportReasonPrompt>> = {
  nudityOrSexual: {
    label: "Nudity or sexual content",
    detail: "Someone is exposed, or the content is sexual.",
  },
  violenceOrGore: {
    label: "Violence or gore",
    detail: "Someone is being hurt, or it is graphic.",
  },
  hateOrHarassment: {
    label: "Hate or harassment",
    detail: "It targets or demeans someone.",
  },
  illegalOrDangerous: {
    label: "Illegal or dangerous",
    detail: "It shows something illegal or seriously unsafe.",
  },
  notMyPhoto: {
    label: "This is me, and I want it taken down",
    detail: "You are in this and did not want it shared.",
  },
  other: {
    label: "Something else",
    detail: "Tell the host what is wrong with it.",
  },
};

/** Host-facing, for the report queue's status column. */
export const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  open: "Open",
  actioned: "Actioned",
  dismissed: "Dismissed",
};

/** "3 reports" / "1 report" — the badge under a flagged card. */
export function formatReportCount(count: number): string {
  return count === 1 ? "1 report" : `${String(Math.max(0, Math.trunc(count)))} reports`;
}

/**
 * Re-exported so a surface that renders the whole list has one import and cannot
 * accidentally iterate a hand-written array that has fallen behind the enum.
 */
export { REPORT_REASONS, REPORT_STATUSES };

/* -------------------------------------------------------------------------- */
/* Sizes and durations                                                        */
/* -------------------------------------------------------------------------- */

const KIB = 1024;

/**
 * "812 KB" / "2.4 MB" / "3.1 GB". Binary units, matching `MEDIA_LIMITS`.
 *
 * Binary rather than decimal because every number a guest sees this next to is
 * binary: `MEDIA_LIMITS` caps a photo at 20 MiB and calls it 20 MB, and a file
 * shown as "21 MB" that is refused for being over "20 MB" is a support question.
 * Consistently wrong beats inconsistently right here.
 *
 * The gigabyte tier exists for exactly one caller — the organiser home's storage
 * figure, which is the sum of a whole party — and for no single file: nothing
 * this app accepts can reach it. Without it a successful party reads "4096 MB",
 * which is a number nobody parses at a glance. `apps/mobile` had the same
 * function without that tier, which is precisely the sort of drift that makes a
 * shared formatter worth the import.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < KIB * KIB) return `${String(Math.max(1, Math.round(bytes / KIB)))} KB`;
  const mib = bytes / (KIB * KIB);
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : String(Math.round(mib))} MB`;
  const gib = mib / 1024;
  return `${gib < 10 ? gib.toFixed(1) : String(Math.round(gib))} GB`;
}

/**
 * "1:04" — a clip's length, for a duration chip.
 *
 * Rounds rather than truncates, so a 9.6-second clip reads "0:10" and not
 * "0:09"; the number beside a play glyph is a rough promise about how long the
 * next minute of somebody's attention is, not a timecode.
 *
 * Accepts `undefined` because the callers are rendering a media row whose
 * `durationSeconds` is optional — a photo has none, and so does a video whose
 * row has not finished settling.
 */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(minutes)}:${String(whole % 60).padStart(2, "0")}`;
}
