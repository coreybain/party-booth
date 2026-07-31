import type { AlreadyUploaded } from "@partybooth/contracts/upload";

import type { UploadAction } from "./machine";

/**
 * Settle a web queue row after the server proves its exact original is present.
 *
 * The reducer intentionally disallows `queued -> uploaded`, so reconciliation
 * walks the same legal lifecycle as a transfer whose bytes moved in this tab.
 * Keeping both actions together prevents the network hook from accidentally
 * reviving the old no-op `duplicateCapture -> uploaded` shortcut.
 */
export function alreadyUploadedActions(
  captureId: string,
  result: AlreadyUploaded,
): readonly UploadAction[] {
  return [
    { type: "uploadStarted", captureId },
    {
      type: "uploaded",
      captureId,
      mediaState: result.state,
      message: "Already sent.",
    },
  ];
}
