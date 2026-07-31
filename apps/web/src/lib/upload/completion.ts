import {
  parseUploadCallbackResult,
  uploadCallbackSucceeded,
  type MediaState,
} from "@/lib/contracts";

const PERMANENT_REASONS = new Set([
  "captureFactsChanged",
  "captureOwnedByOther",
  "derivativeNotDistinct",
  "duplicateDerivative",
  "duplicateFile",
  "eventGone",
  "ownerDeleted",
  "ownerDeletionScheduled",
  "tooLong",
  "withdrawn",
]);

export type ClientUploadCompletion =
  | { readonly ok: true; readonly state: MediaState | undefined }
  | {
      readonly ok: false;
      readonly reason: string | undefined;
      readonly message: string;
      readonly retryable: boolean;
    };

/** Turn UploadThing's normal callback serverData into an honest client result. */
export function clientUploadCompletion(value: unknown): ClientUploadCompletion {
  const result = parseUploadCallbackResult(value);
  if (uploadCallbackSucceeded(result)) {
    return { ok: true, state: result.state ?? undefined };
  }

  return {
    ok: false,
    reason: result.reason,
    message:
      result.reason === "tooLong"
        ? "That video is longer than the 60-second limit."
        : result.reason === "withdrawn"
          ? "That item was withdrawn before it finished sending."
          : "The file reached storage but could not be added to the party. Try again.",
    retryable: result.reason === undefined || !PERMANENT_REASONS.has(result.reason),
  };
}
