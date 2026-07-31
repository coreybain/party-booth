import { constantTimeEqual } from "@partybooth/contracts/codes";
import { envOptional, serverEnv } from "@partybooth/env/server";

import { unauthenticated } from "./errors";

/** Prove a completion came from PartyBooth's signed UploadThing callback. */
export function requireUploadCallbackSecret(supplied: string): void {
  const expected = envOptional(serverEnv, "UPLOAD_CALLBACK_SECRET");
  if (expected === undefined || !constantTimeEqual(expected, supplied)) {
    // An unset secret and a wrong one deliberately look identical externally.
    throw unauthenticated("This endpoint is not callable from a client.");
  }
}
