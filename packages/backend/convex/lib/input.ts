import type { z } from "zod";

import { invalidInput } from "./errors";

/**
 * Validate mutation arguments against a schema from `@partybooth/contracts`.
 *
 * Convex validators (`v.string()`, `v.number()`) already guard the *shape* of
 * the arguments — that is what stops a malformed call reaching the handler at
 * all. What they cannot express is the domain rules: an event name is 1–80
 * characters after trimming, `endsAt` must be after `startsAt`, a colour is
 * `#rrggbb`, a join code is six digits with the formatting stripped. Those live
 * in zod, are shared with both clients, and are applied here so the server
 * never trusts a client-side check.
 *
 * The transforms matter as much as the refinements: this is also where a name
 * gets trimmed and an email lower-cased, so the value written to the database
 * is the normalised one.
 */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  // The first issue only. A guest fixing one field at a time is better served
  // than by a wall of text, and the client has the same schema for field-level
  // messages anyway.
  const issue = result.error.issues[0];
  const path = issue?.path.join(".");
  throw invalidInput(
    issue === undefined
      ? "That input is not valid."
      : path
        ? `${path}: ${issue.message}`
        : issue.message,
  );
}
