/**
 * Who gets to name a user.
 *
 * Two sources want to write `users.displayName`: the identity provider, via the
 * Better Auth `user.onUpdate` trigger in `auth.ts`, and the human themselves,
 * via `users.updateProfile`. The rule between them is small enough to state in
 * one sentence and important enough to be a function with tests, because
 * getting it wrong is invisible until a host sees the wrong name in their
 * moderation queue:
 *
 * **A provider name is a default. A default never overwrites a choice.**
 *
 * `onboardedAt` is what tells the two apart — `displayName` cannot, because it
 * falls back to the local part of the email address and so is never empty.
 */
export function resolveDisplayName(params: {
  /** What `users.displayName` holds today. */
  readonly current: string;
  /** `user.name` on the Better Auth document, which may be absent or blank. */
  readonly providerName: string | null | undefined;
  /** Set once the human has confirmed a name for themselves. */
  readonly onboardedAt: number | undefined;
}): string {
  // Confirmed: the provider has nothing to add. Verifying an email address is
  // enough to fire `onUpdate`, and without this a guest who typed "Sam" would
  // silently revert to "Samantha Smith" the next time it did.
  if (params.onboardedAt !== undefined) return params.current;

  // Not yet confirmed: the provider's name is the best guess available, but a
  // blank one is not an improvement on what is already there.
  const provided = params.providerName?.trim();
  return provided ? provided : params.current;
}
