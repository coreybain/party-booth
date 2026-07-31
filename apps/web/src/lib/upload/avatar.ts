import {
  checkAvatarTicketAgainstFiles,
  checkAvatarTicketAgainstGrant,
  type AvatarUploadTicket,
  type IssuedAvatarUploadGrant,
  type OfferedFile,
} from "@/lib/contracts";

export type AvatarEdgeAuthorisation = { ok: true } | { ok: false; message: string };

/**
 * Bind the offered body to both the client's ticket and Convex's authoritative
 * grant facts before UploadThing creates a presigned URL.
 */
export function authoriseAvatarUploadAtEdge(
  ticket: AvatarUploadTicket,
  files: readonly OfferedFile[],
  grant: Pick<IssuedAvatarUploadGrant, "byteSize" | "mimeType" | "checksum">,
): AvatarEdgeAuthorisation {
  const offered = checkAvatarTicketAgainstFiles(ticket, files);
  if (!offered.ok) return { ok: false, message: offered.message };

  const bound = checkAvatarTicketAgainstGrant(ticket, grant);
  if (!bound.ok) return { ok: false, message: bound.message };
  return { ok: true };
}
