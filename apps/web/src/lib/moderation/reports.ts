/**
 * Host-facing copy for a content report.
 *
 * The reasons themselves are `REPORT_REASONS` in `@partybooth/contracts/media`,
 * shared with `apps/mobile`, where the *guest* picks one. These are the words
 * the host reads on the other side of it, and they are deliberately flatter than
 * the guest's: a host looking at a reported photo needs a category, not an
 * accusation, and the fewer adjectives between them and the picture the better.
 *
 * What is **not** here, and must never be, is who reported it. `moderation.flagged`
 * does not return the reporter — a host who knows which guest reported which
 * other guest is a host who can be asked to take sides.
 */

import {
  formatReportCount,
  REPORT_REASON_LABELS,
  REPORT_STATUS_LABELS,
} from "@partybooth/contracts/copy";

/**
 * Hoisted into the contract in Sprint 4's integration pass, next to the guest's
 * register of the same enum (`REPORT_REASON_PROMPTS`, which `apps/mobile`
 * renders). Kept exported under this module's names so the components that read
 * them did not have to change, and so this file stays the place a reader looks
 * for "what does the host see about a report".
 */
export const REPORT_REASON_COPY = REPORT_REASON_LABELS;
export const REPORT_STATUS_COPY = REPORT_STATUS_LABELS;
export { formatReportCount };
