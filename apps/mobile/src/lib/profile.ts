/**
 * The guest's own profile: validating the name they confirm, and remembering the
 * photo they picked until Sprint 3 can upload it.
 *
 * The name rule is **not** decided here. `displayNameSchema` in
 * `@partybooth/contracts/schemas` is the same schema `packages/backend` parses
 * against, so the field can refuse a name before a round trip without the two ever
 * disagreeing about what "too long" means.
 *
 * No React Native imports — unit-tested in plain Node. The storage side of the same
 * concern lives in `./local-profile`, which does import Expo modules.
 */

import { displayNameSchema } from "@partybooth/contracts/schemas";

/**
 * Longest name the contract accepts. Used as `maxLength` on the field, so the
 * keyboard stops rather than the form rejecting after the fact.
 */
export const DISPLAY_NAME_MAX_LENGTH = 60;

export interface DisplayNameState {
  /** Trimmed and ready to send. Empty when the input is only whitespace. */
  readonly value: string;
  readonly valid: boolean;
  /** The contract's own message, shown only once it is worth showing. */
  readonly error: string | null;
}

/**
 * Validate a typed display name.
 *
 * `touched` exists because an empty field on first render is not a mistake, it is a
 * starting point — a red "Enter a name." before the guest has typed anything reads as
 * an accusation. The error only surfaces once they have engaged with the field.
 */
export function readDisplayName(raw: string, touched = false): DisplayNameState {
  const parsed = displayNameSchema.safeParse(raw);
  if (parsed.success) {
    return { value: parsed.data, valid: true, error: null };
  }
  const message = parsed.error.issues[0]?.message ?? "Enter a name.";
  return {
    value: raw.trim(),
    valid: false,
    error: touched ? message : null,
  };
}

/** The letter shown in the avatar circle before a photo exists. */
export function initialFor(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

/* -------------------------------------------------------------------------- */
/* What we remember locally                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The part of the profile that has nowhere to live on the server yet.
 *
 * - `photoUri` is a **local** `file://` from the picker. Avatars ride the same
 *   short-lived upload-grant pipeline as party media, which Sprint 3 builds; sending
 *   a device path to Convex would store a string no other device can resolve. So the
 *   choice is kept here and uploaded when the pipeline exists.
 *
 * Whether the guest has *been through* that screen is deliberately **not** here any
 * more. It used to be a `confirmedAt` timestamp on this record, because Convex could
 * not answer the question — `users.displayName` is never empty, so "Sam chose this"
 * and "we derived this from sam@example.com" looked identical. `users.onboardedAt`
 * now answers it, which means a reinstall no longer re-prompts and two devices agree.
 */
export interface LocalProfile {
  readonly photoUri?: string;
}

export const EMPTY_LOCAL_PROFILE: LocalProfile = {};

/**
 * Storage key for one account.
 *
 * Scoped by user id so two people sharing a phone — a real thing at a party, when
 * someone signs in to send one photo — never inherit each other's avatar. Expo's
 * secure store only accepts `[A-Za-z0-9._-]` in a key, so anything else is folded to
 * `_`; Convex ids are already in that set, and the fold is belt and braces.
 */
export function localProfileKey(userId: string): string {
  return `profile.${userId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Round-trip through JSON, tolerating anything a previous version may have written. */
export function serialiseLocalProfile(profile: LocalProfile): string {
  return JSON.stringify(profile);
}

export function parseLocalProfile(raw: string | null | undefined): LocalProfile {
  if (!raw) return EMPTY_LOCAL_PROFILE;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_LOCAL_PROFILE;
    const record = value as Record<string, unknown>;
    // Anything else a previous version wrote — `confirmedAt`, before
    // `users.onboardedAt` existed — is dropped rather than migrated.
    const photoUri = typeof record.photoUri === "string" ? record.photoUri : undefined;
    return photoUri === undefined ? EMPTY_LOCAL_PROFILE : { photoUri };
  } catch {
    // Corrupt or hand-edited: losing an avatar choice is not worth a crash loop.
    return EMPTY_LOCAL_PROFILE;
  }
}
