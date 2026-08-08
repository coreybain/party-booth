"use client";

import {
  AVATAR_JPEG_QUALITY,
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPE,
  avatarPixelSize,
  avatarUploadRequestSchema,
  buildAvatarUploadTicket,
  parseAvatarUploadCompletionResult,
  type IssuedAvatarUploadGrant,
} from "@/lib/contracts";
import { checksumOfBlob } from "@/lib/upload/checksum";
import { AVATAR_IMAGE_ROUTE, uploadFiles } from "@/lib/upload/uploader";

/** Accept only callback outcomes that attached this exact file to the account. */
export function requireSuccessfulAvatarCompletion(value: unknown): void {
  const completion = parseAvatarUploadCompletionResult(value);
  if (completion.outcome !== "registered" && completion.outcome !== "duplicate") {
    throw new Error("The profile photo was uploaded but could not be attached. Try again.");
  }
}

/** Decode and re-encode the selected image before requesting a bound upload grant. */
export async function prepareBrowserAvatar(source: File): Promise<File> {
  const bitmap = await createImageBitmap(source);
  try {
    const fitted = avatarPixelSize({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot prepare a profile photo.");
    context.drawImage(bitmap, 0, 0, fitted.width, fitted.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value === null) reject(new Error("This photo could not be converted to JPEG."));
          else resolve(value);
        },
        AVATAR_MIME_TYPE,
        AVATAR_JPEG_QUALITY,
      );
    });
    if (blob.size > AVATAR_MAX_BYTES) {
      throw new Error("That profile photo is still too large after resizing. Choose another one.");
    }

    const checksum = await checksumOfBlob(blob);
    return new File([blob], `avatar-${checksum.slice(0, 16)}.jpg`, {
      type: AVATAR_MIME_TYPE,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

/** Use the same single-use Convex grant and private UploadThing callback as mobile. */
export async function uploadBrowserAvatar({
  source,
  requestGrant,
}: {
  readonly source: File;
  readonly requestGrant: (request: {
    byteSize: number;
    mimeType: typeof AVATAR_MIME_TYPE;
    checksum: string;
  }) => Promise<IssuedAvatarUploadGrant>;
}): Promise<void> {
  const prepared = await prepareBrowserAvatar(source);
  const checksum = await checksumOfBlob(prepared);
  const request = avatarUploadRequestSchema.parse({
    byteSize: prepared.size,
    mimeType: AVATAR_MIME_TYPE,
    checksum,
  });
  const grant = await requestGrant(request);
  const [uploaded] = await uploadFiles(AVATAR_IMAGE_ROUTE, {
    files: [prepared],
    input: buildAvatarUploadTicket(grant),
  });
  requireSuccessfulAvatarCompletion(uploaded?.serverData);
}
