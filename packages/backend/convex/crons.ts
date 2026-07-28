import { cronJobs } from "convex/server";

import { deletionFunctions } from "./deletion";

/**
 * Scheduled work.
 *
 * One job at launch, and it is the one that makes a promise true rather than
 * merely stated: the thirty-day account purge. Before it existed, "delete my
 * account" moved a row to `deletionScheduled` and nothing ever came back for it
 * — indefinite deactivation with a deletion label on the button, which is not
 * what Apple's account-deletion guideline or Play's data-safety declaration ask
 * for. `deletion.runDueDeletions` is the worker; this is what runs it.
 *
 * **Daily rather than hourly.** The unit of the promise is a day ("thirty
 * days"), the work is bounded per run and re-runs the next day if a backlog
 * builds, and a job that runs while a party is in progress is a job competing
 * for the same transactions as the uploads. 04:00 UTC is the quietest hour for
 * a product whose users are, at launch, in one timezone.
 */
const crons = cronJobs();

crons.daily(
  "purge accounts whose thirty days are up",
  { hourUTC: 4, minuteUTC: 0 },
  deletionFunctions.runDueDeletions,
  {},
);

export default crons;
