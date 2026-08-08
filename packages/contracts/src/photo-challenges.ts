import { z } from "zod";

import type { RandomBytes } from "./codes";

export const PHOTO_CHALLENGE_MIN_ACTIVE = 3;
export const PHOTO_CHALLENGE_MAX_ACTIVE = 50;
export const PHOTO_CHALLENGE_MAX_LENGTH = 120;

/** Balanced, family-friendly prompts copied into every newly-created event. */
export const PHOTO_CHALLENGE_STARTER_DECK = [
  "Capture the biggest laugh in the room",
  "Find two people who just met",
  "Photograph a tiny detail worth remembering",
  "Recreate a famous movie poster",
  "Catch someone mid-dance move",
  "Show us the party from a surprising angle",
  "Find the most colourful thing here",
  "Take a photo that feels like a celebration",
  "Capture a friendship in one frame",
  "Photograph the best-dressed shoes",
  "Find a reflection and use it creatively",
  "Catch a candid moment of kindness",
  "Make an ordinary object look dramatic",
  "Photograph a perfect high five",
  "Find three generations in one frame",
  "Capture the calmest moment at the party",
  "Take a photo with everyone looking somewhere else",
  "Show the view from table height",
  "Photograph something that tells the party's story",
  "Catch the moment before everyone poses",
  "Find a pattern made by people",
  "Take a photo that would make the host smile",
  "Capture the energy without showing a face",
  "Create a group portrait with an unusual pose",
  "Capture the loudest cheer of the night",
  "Find a perfect colour match between two guests",
  "Take a photo through something transparent",
  "Capture hands making or serving something",
  "Find the funniest facial expression",
  "Photograph a detail the host carefully chose",
  "Create a portrait using only silhouettes",
  "Catch someone helping behind the scenes",
  "Frame a guest inside a doorway or window",
  "Capture a toast from an unexpected viewpoint",
  "Find something that matches the party theme",
  "Arrange a group from shortest to tallest",
  "Capture someone completely lost in the music",
  "Show movement with a playful blur",
  "Find two guests wearing matching colours",
  "Take a close-up that makes the object hard to guess",
  "Capture the first bite of something delicious",
  "Photograph a spontaneous reunion",
  "Find the brightest smile in the room",
  "Take a picture with a surprise in the foreground",
  "Capture a quiet conversation",
  "Photograph the party from above",
  "Make a tiny object look enormous",
  "Catch someone making another person laugh",
  "Find a scene with three bold colours",
  "Create a photo that looks like an album cover",
] as const;

export const photoChallengePromptSchema = z
  .string()
  .trim()
  .min(1, "Write a challenge first.")
  .max(
    PHOTO_CHALLENGE_MAX_LENGTH,
    `Challenges can be at most ${PHOTO_CHALLENGE_MAX_LENGTH} characters.`,
  );

/** Event-local duplicate key: trim, collapse whitespace and compare case-insensitively. */
export function normalizePhotoChallengePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** Pick without `Math.random`, with an injectable cryptographic byte source for tests. */
export function pickPhotoChallengeIndex(
  length: number,
  randomBytes: RandomBytes = cryptoRandomBytes,
): number {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError("A challenge can only be picked from a non-empty deck.");
  }
  const bytes = randomBytes(4);
  if (bytes.length < 4) throw new Error("Random source returned too few bytes.");
  const value =
    ((bytes[0] ?? 0) * 0x1000000 +
      (bytes[1] ?? 0) * 0x10000 +
      (bytes[2] ?? 0) * 0x100 +
      (bytes[3] ?? 0)) >>>
    0;
  return value % length;
}

function cryptoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
