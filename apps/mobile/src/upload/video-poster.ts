import { posterFrameTime } from "@partybooth/contracts/capture";

import type { VideoPlayer, VideoThumbnail } from "expo-video";

type PosterPlayer = Pick<VideoPlayer, "generateThumbnailsAsync" | "replaceAsync">;

/**
 * Load a recorded clip and extract a representative still.
 *
 * A freshly-created native player starts empty so `replaceAsync` is the load
 * barrier: on iOS it moves asset loading off the UI thread, and on both native
 * platforms it ensures thumbnail generation cannot race player construction.
 * Frame zero is a recovery frame only; the preferred frame remains one second
 * in (or the midpoint of a very short clip), after camera exposure has settled.
 */
export async function generateVideoPosterFrame(
  player: PosterPlayer,
  videoUri: string,
  durationSeconds: number,
  maxWidth: number,
): Promise<VideoThumbnail> {
  await player.replaceAsync({ uri: videoUri });

  const preferredTime = posterFrameTime(durationSeconds);
  const candidateTimes = preferredTime === 0 ? [0] : [preferredTime, 0];
  let lastError: unknown;

  for (const time of candidateTimes) {
    try {
      const [thumbnail] = await player.generateThumbnailsAsync([time], { maxWidth });
      if (thumbnail !== undefined) return thumbnail;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error("The recorded video did not yield a preview frame.", {
    ...(lastError === undefined ? {} : { cause: lastError }),
  });
}
