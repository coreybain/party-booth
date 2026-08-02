import {
  AVATAR_JPEG_QUALITY,
  AVATAR_MIME_TYPE,
  AVATAR_UPLOAD_ROUTE_PATH,
  AVATAR_UPLOAD_ROUTE_SLUG,
  avatarPixelSize,
  parseAvatarUploadCompletionResult,
  avatarUploadRequestSchema,
  buildAvatarUploadTicket,
  type AvatarUploadRequest,
  type AvatarUploadCompletionResult,
  type AvatarUploadTicket,
  type IssuedAvatarUploadGrant,
} from "@partybooth/contracts/avatar";
import { toHex } from "@partybooth/contracts/capture";

import type { FileRoute } from "uploadthing/types";

import { credentialSafeUploadFetch } from "./credential-safe-fetch";
import { UploadCompletionError } from "./transport";

export interface PreparedAvatar {
  readonly uri: string;
  readonly name: string;
  readonly byteSize: number;
  readonly mimeType: typeof AVATAR_MIME_TYPE;
  readonly checksum: string;
}

export type AvatarUploadAuthHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface AvatarUploadRuntime {
  /** Decode, resize and JPEG re-encode; the result must be a disposable temp file. */
  prepare(sourceUri: string): Promise<PreparedAvatar>;
  upload(input: {
    siteUrl: string;
    file: PreparedAvatar;
    ticket: AvatarUploadTicket;
    authHeaders?: AvatarUploadAuthHeaders | undefined;
  }): Promise<void>;
  dispose(uri: string): Promise<void>;
}

export interface UploadAvatarInput {
  readonly sourceUri: string;
  readonly siteUrl: string;
  readonly requestGrant: (request: AvatarUploadRequest) => Promise<IssuedAvatarUploadGrant>;
  /**
   * Better Auth's stored Cookie header. Native fetch has no browser cookie jar
   * for the web origin, so the caller must forward it explicitly.
   */
  readonly authHeaders?: AvatarUploadAuthHeaders | undefined;
  /** Injectable so the orchestration is testable without loading Expo native modules. */
  readonly runtime?: AvatarUploadRuntime;
}

/** Fail closed unless the server callback attached this exact avatar. */
export function requireSuccessfulAvatarCompletion(value: unknown): void {
  const completion = parseAvatarUploadCompletionResult(value);
  if (completion.outcome !== "registered" && completion.outcome !== "duplicate") {
    throw new UploadCompletionError(completion.reason, "profile photo");
  }
}

/**
 * Re-encode one selected image, bind its exact facts in Convex, and send it to
 * the private avatar route. The durable provider key never exists in this API.
 */
export async function uploadAvatar(input: UploadAvatarInput): Promise<void> {
  const runtime = input.runtime ?? expoAvatarUploadRuntime;
  const prepared = await runtime.prepare(input.sourceUri);

  try {
    const request = avatarUploadRequestSchema.parse({
      byteSize: prepared.byteSize,
      mimeType: prepared.mimeType,
      checksum: prepared.checksum,
    });
    const grant = await input.requestGrant(request);
    await runtime.upload({
      siteUrl: input.siteUrl,
      file: prepared,
      ticket: buildAvatarUploadTicket(grant),
      ...(input.authHeaders === undefined ? {} : { authHeaders: input.authHeaders }),
    });
  } finally {
    // The picker-owned source remains untouched; only our re-encoded temp copy
    // is disposable, on success and on every failure branch. Cleanup is
    // best-effort and must not turn a registered avatar into an apparent error.
    await runtime.dispose(prepared.uri).catch(() => undefined);
  }
}

type AvatarRouter = {
  readonly [AVATAR_UPLOAD_ROUTE_SLUG]: FileRoute<{
    input: AvatarUploadTicket;
    output: AvatarUploadCompletionResult;
    errorShape: unknown;
  }>;
};

/** Native implementation, loaded lazily so pure tests never evaluate Expo modules. */
export const expoAvatarUploadRuntime: AvatarUploadRuntime = {
  async prepare(sourceUri) {
    const [{ ImageManipulator, SaveFormat }, { File: DeviceFile }, Crypto] = await Promise.all([
      import("expo-image-manipulator"),
      import("expo-file-system"),
      import("expo-crypto"),
    ]);

    const probed = await ImageManipulator.manipulate(sourceUri).renderAsync();
    const fitted = avatarPixelSize({ width: probed.width, height: probed.height });
    let context = ImageManipulator.manipulate(probed);
    if (fitted.width !== probed.width || fitted.height !== probed.height) {
      context = context.resize(fitted);
    }
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({
      format: SaveFormat.JPEG,
      compress: AVATAR_JPEG_QUALITY,
    });

    const bytes = await new DeviceFile(saved.uri).bytes();
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    const checksum = toHex(digest);
    return {
      uri: saved.uri,
      name: `avatar-${checksum.slice(0, 16)}.jpg`,
      byteSize: bytes.byteLength,
      mimeType: AVATAR_MIME_TYPE,
      checksum,
    };
  },

  async upload({ siteUrl, file, ticket, authHeaders }) {
    const { genUploader } = await import("uploadthing/client");
    const response = await fetch(file.uri);
    const blob = await response.blob();
    const nativeFile = Object.assign(new File([blob], file.name, { type: file.mimeType }), {
      uri: file.uri,
    });
    const { uploadFiles } = genUploader<AvatarRouter>({
      url: `${siteUrl.replace(/\/$/, "")}${AVATAR_UPLOAD_ROUTE_PATH}`,
      package: "@partybooth/mobile",
      fetch: credentialSafeUploadFetch,
    });
    const [uploaded] = await uploadFiles(AVATAR_UPLOAD_ROUTE_SLUG, {
      files: [nativeFile],
      input: ticket,
      ...(authHeaders === undefined ? {} : { headers: authHeaders }),
    });
    requireSuccessfulAvatarCompletion(uploaded?.serverData);
  },

  async dispose(uri) {
    const { File: DeviceFile } = await import("expo-file-system");
    const file = new DeviceFile(uri);
    if (file.exists) file.delete();
  },
};
