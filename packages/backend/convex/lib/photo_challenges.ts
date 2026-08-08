import {
  normalizePhotoChallengePrompt,
  PHOTO_CHALLENGE_STARTER_DECK,
} from "@partybooth/contracts/photo-challenges";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Copy the starter prompts into a new event; existing events remain opt-out. */
export async function seedPhotoChallengeStarterDeck(
  ctx: MutationCtx,
  eventId: Id<"events">,
  actorUserId: Id<"users">,
  now: number,
): Promise<void> {
  for (const prompt of PHOTO_CHALLENGE_STARTER_DECK) {
    await ctx.db.insert("photoChallenges", {
      eventId,
      prompt,
      normalizedPrompt: normalizePhotoChallengePrompt(prompt),
      status: "active",
      source: "starter",
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    });
  }
}
