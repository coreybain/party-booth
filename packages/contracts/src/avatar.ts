import { z } from "zod";

import { fitWithin, type PixelSize } from "./capture";
import { checksumSchema } from "./schemas";
import {
  checkTicketAgainstFiles,
  normaliseMime,
  UPLOAD_ROUTE_PATH,
  type OfferedFile,
  type TicketCheck,
} from "./upload";

/** Avatars are always decoded and re-encoded as a small JPEG before upload. */
export const AVATAR_MIME_TYPE = "image/jpeg" as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_EDGE = 512;
export const AVATAR_JPEG_QUALITY = 0.82;
export const AVATAR_GRANT_POLICY = {
  ttlMs: 2 * 60 * 1_000,
  maxPerWindow: 10,
  windowMs: 5 * 60 * 1_000,
} as const;

/** A second private UploadThing route, kept separate from event media. */
export const AVATAR_UPLOAD_ROUTE_SLUG = "avatarImage" as const;
export const AVATAR_UPLOAD_ROUTE_PATH = UPLOAD_ROUTE_PATH;

const avatarFileFields = {
  byteSize: z.number().int().positive().max(AVATAR_MAX_BYTES),
  mimeType: z.literal(AVATAR_MIME_TYPE),
  checksum: checksumSchema,
} as const;

/** What a signed-in account asks Convex to bind into a single-use grant. */
export const avatarUploadRequestSchema = z.object(avatarFileFields);
export type AvatarUploadRequest = z.infer<typeof avatarUploadRequestSchema>;

/** What the phone sends to the private UploadThing avatar route. */
export const avatarUploadTicketSchema = z.object({
  secret: z.string().min(16).max(512),
  ...avatarFileFields,
});
export type AvatarUploadTicket = z.infer<typeof avatarUploadTicketSchema>;

/** A capability returned once. There is deliberately no provider file key. */
export interface IssuedAvatarUploadGrant {
  readonly secret: string;
  readonly expiresAt: number;
  readonly byteSize: number;
  readonly mimeType: typeof AVATAR_MIME_TYPE;
  readonly checksum: string;
}

export function buildAvatarUploadTicket(grant: IssuedAvatarUploadGrant): AvatarUploadTicket {
  return {
    secret: grant.secret,
    byteSize: grant.byteSize,
    mimeType: grant.mimeType,
    checksum: grant.checksum,
  };
}

/** Cheap edge check: the offered body must agree with the ticket. */
export function checkAvatarTicketAgainstFiles(
  ticket: AvatarUploadTicket,
  files: readonly OfferedFile[],
): TicketCheck {
  return checkTicketAgainstFiles(ticket, files);
}

export type AvatarGrantTicketMismatch = "byteSize" | "mimeType" | "checksum";
export type AvatarGrantTicketCheck =
  { ok: true } | { ok: false; reason: AvatarGrantTicketMismatch; message: string };

/**
 * Authoritative edge binding: every value on `grant` came back from Convex.
 * One deliberately vague message covers every mismatch.
 */
export function checkAvatarTicketAgainstGrant(
  ticket: AvatarUploadTicket,
  grant: Pick<IssuedAvatarUploadGrant, "byteSize" | "mimeType" | "checksum">,
): AvatarGrantTicketCheck {
  const fail = (reason: AvatarGrantTicketMismatch): AvatarGrantTicketCheck => ({
    ok: false,
    reason,
    message: "That profile photo is not the file this upload was authorised for.",
  });

  if (ticket.byteSize !== grant.byteSize) return fail("byteSize");
  if (normaliseMime(ticket.mimeType) !== normaliseMime(grant.mimeType)) return fail("mimeType");
  if (ticket.checksum !== grant.checksum) return fail("checksum");
  return { ok: true };
}

/** Resize without stretching; square cropping remains the picker's responsibility. */
export function avatarPixelSize(source: PixelSize): PixelSize {
  return fitWithin(source, AVATAR_MAX_EDGE);
}

export const AVATAR_UPLOAD_COMPLETION_OUTCOMES = [
  "registered",
  "duplicate",
  "discarded",
  "rejected",
] as const;

export type AvatarUploadCompletionOutcome = (typeof AVATAR_UPLOAD_COMPLETION_OUTCOMES)[number];

export interface AvatarUploadCompletionResult {
  readonly outcome: AvatarUploadCompletionOutcome;
  readonly reason?: string;
}

export const avatarUploadCompletionResultSchema = z.object({
  outcome: z.enum(AVATAR_UPLOAD_COMPLETION_OUTCOMES),
  reason: z.string().min(1).optional(),
});

export function parseAvatarUploadCompletionResult(value: unknown): AvatarUploadCompletionResult {
  return avatarUploadCompletionResultSchema.parse(value);
}
