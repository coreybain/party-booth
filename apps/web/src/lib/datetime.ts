/**
 * Wall-clock ↔ epoch conversion, in the event's own time zone.
 *
 * Every timestamp PartyBooth stores is epoch milliseconds (`timestampSchema` in
 * contracts). Every timestamp a host *types* is a wall-clock time in a named
 * zone — "the party starts at 8pm in London" — and those two are not the same
 * fact. Getting the conversion wrong by an hour twice a year is exactly the
 * kind of bug that only shows up at the door.
 *
 * `Intl` does the work: it is the only thing in the platform that knows the
 * IANA database, and it is present in every browser this app supports and in
 * Node 26. Nothing here needs a date library.
 */

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * How far the zone is ahead of UTC at a given instant, in milliseconds.
 *
 * Works by formatting the instant *in* the zone and reading the wall-clock
 * fields back — the standard trick, and the only one that handles historical
 * rule changes rather than assuming a fixed offset.
 */
function zoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  // Milliseconds are not in the formatted output, so compare on whole seconds.
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

/** Is this a time zone `Intl` actually knows? Cheap, and the only real check. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `"2026-08-05T20:00"` in `Europe/London` → epoch milliseconds.
 *
 * Returns `undefined` for a malformed value or an unknown zone, so a caller can
 * show a field error rather than storing a silently-wrong instant.
 *
 * The two-pass offset lookup is what makes daylight-saving boundaries work: the
 * first guess uses the offset that applies to the *UTC reading* of those
 * digits, then re-checks the offset at the instant that produced. A wall-clock
 * time that does not exist (the spring-forward hour) resolves forward, which is
 * the same thing every calendar app does.
 */
export function zonedInputToTimestamp(localInput: string, timeZone: string): number | undefined {
  const match = ISO_LOCAL.exec(localInput.trim());
  if (!match) return undefined;
  if (!isKnownTimeZone(timeZone)) return undefined;

  const [, year, month, day, hour, minute] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );

  const firstGuess = asUtc - zoneOffsetMs(asUtc, timeZone);
  const corrected = asUtc - zoneOffsetMs(firstGuess, timeZone);
  return corrected;
}

/** Epoch milliseconds → the `datetime-local` value for that zone. */
export function timestampToZonedInput(timestamp: number, timeZone: string): string {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(timestamp));

  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}`;
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

/** "Wed 5 Aug, 20:00" — the event's zone, never the reader's. */
export function formatInZone(timestamp: number, timeZone: string): string {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

/**
 * One line for the whole schedule.
 *
 * The end time drops the date when it falls on the same day, because
 * "Wed 5 Aug, 20:00 – 23:30" is what a host reads at a glance and
 * "Wed 5 Aug, 20:00 – Wed 5 Aug, 23:30" is not.
 */
export function formatSchedule(
  startsAt: number,
  endsAt: number | undefined,
  timeZone: string,
): string {
  const start = formatInZone(startsAt, timeZone);
  if (endsAt === undefined) return start;

  const sameDay =
    timestampToZonedInput(startsAt, timeZone).slice(0, 10) ===
    timestampToZonedInput(endsAt, timeZone).slice(0, 10);

  if (sameDay) {
    const end = timestampToZonedInput(endsAt, timeZone).slice(11);
    return `${start} – ${end}`;
  }
  return `${start} – ${formatInZone(endsAt, timeZone)}`;
}

/** "GMT+1" for the zone at that instant — the bit that stops a 3am mistake. */
export function timeZoneAbbreviation(timestamp: number, timeZone: string): string {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(timestamp));
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
  // Node and some browsers render a zero offset as "GMT+0"; the plain "GMT" is
  // what a host expects to read next to a January date.
  return name === "GMT+0" || name === "UTC+0" ? "GMT" : name;
}

/**
 * "in 3 days" / "2 hours ago". `Intl.RelativeTimeFormat` picks the unit; we
 * only choose the threshold.
 */
export function formatRelative(timestamp: number, now: number): string {
  const formatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  const deltaSeconds = Math.round((timestamp - now) / 1000);
  const magnitude = Math.abs(deltaSeconds);

  if (magnitude < 60) return formatter.format(deltaSeconds, "second");
  if (magnitude < 3600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (magnitude < 86_400) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
  if (magnitude < 2_592_000) return formatter.format(Math.round(deltaSeconds / 86_400), "day");
  return formatter.format(Math.round(deltaSeconds / 2_592_000), "month");
}

/* -------------------------------------------------------------------------- */
/* Zone list                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The browser's own zone. `undefined` on the server, deliberately: rendering a
 * server-guessed zone and then correcting it on the client is a hydration
 * mismatch, so the form fills this in after mount instead.
 */
export function browserTimeZone(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && isKnownTimeZone(resolved) ? resolved : undefined;
}

/**
 * A shortlist for the picker, biased towards where a beta host actually is,
 * with the browser's own zone pinned to the top.
 *
 * `Intl.supportedValuesOf` gives all ~450 zones where it exists; a `<select>`
 * that long is unusable on a phone, so the full list is offered as a fallback
 * only when the browser's zone is not one we shortlisted.
 */
const COMMON_TIME_ZONES = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
] as const;

export function timeZoneOptions(preferred?: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const zone of [preferred, ...COMMON_TIME_ZONES]) {
    if (zone === undefined || seen.has(zone) || !isKnownTimeZone(zone)) continue;
    seen.add(zone);
    options.push(zone);
  }
  return options;
}

/** "Europe/London" → "Europe / London", which wraps on a narrow screen. */
export function formatTimeZoneLabel(timeZone: string): string {
  return timeZone.replace(/_/g, " ").replace("/", " / ");
}
