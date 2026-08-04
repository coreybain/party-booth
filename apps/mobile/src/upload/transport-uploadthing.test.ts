import { buildUploadTicket } from "@partybooth/contracts/upload";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  genUploader: vi.fn(),
}));

vi.mock("uploadthing/client", () => ({
  genUploader: (...args: unknown[]) => sdk.genUploader(...args),
}));

import { createUploadThingTransport } from "./transport-uploadthing";
import type { UploadCompletionError } from "./transport";

const ticket = buildUploadTicket(
  {
    outcome: "granted",
    grantId: "grant_1",
    secret: "s".repeat(32),
    eventId: "event_1",
    captureId: "mdeadbeefdeadbeefdeadbeefdeadbeef",
    mediaType: "photo",
    mediaSource: "capture",
    storageRegion: "pdx1",
    byteSize: 4,
    maxBytes: 20 * 1024 * 1024,
    expiresAt: Date.now() + 60_000,
  },
  { mimeType: "image/jpeg", checksum: "a".repeat(64) },
);

beforeEach(() => {
  vi.restoreAllMocks();
  sdk.uploadFiles.mockReset();
  sdk.genUploader.mockReset().mockReturnValue({ uploadFiles: sdk.uploadFiles });
  vi.stubGlobal("fetch", vi.fn());
});

function send(transport: ReturnType<typeof createUploadThingTransport>) {
  return transport.upload({
    file: {
      uri: "file:///documents/photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      byteSize: 4,
    },
    ticket,
  });
}

describe("UploadThing native transport", () => {
  it("hands React Native a URI descriptor without reading the file through Blob", async () => {
    sdk.uploadFiles.mockResolvedValue([
      { serverData: { outcome: "registered", state: "pending" } },
    ]);
    const transport = createUploadThingTransport({ siteUrl: "https://partybooth.test" });

    await send(transport);

    expect(fetch).not.toHaveBeenCalled();
    expect(sdk.uploadFiles).toHaveBeenCalledWith(
      "partyMedia",
      expect.objectContaining({
        files: [
          {
            uri: "file:///documents/photo.jpg",
            name: "photo.jpg",
            type: "image/jpeg",
            size: 4,
            lastModified: 0,
          },
        ],
      }),
    );
  });

  it("resolves the current Better Auth Cookie header for each attempt", async () => {
    const authHeaders = vi.fn(() => ({ cookie: "better-auth.session_token=private" }));
    sdk.uploadFiles.mockResolvedValue([
      { serverData: { outcome: "registered", state: "pending" } },
    ]);
    const transport = createUploadThingTransport({
      siteUrl: "https://partybooth.test",
      authHeaders,
    });

    await send(transport);

    const options = sdk.uploadFiles.mock.calls[0]?.[1] as { headers?: () => HeadersInit };
    expect(options.headers).toBe(authHeaders);
    expect(options.headers?.()).toEqual({ cookie: "better-auth.session_token=private" });
  });

  it("does not report success when the authoritative callback discarded the file", async () => {
    sdk.uploadFiles.mockResolvedValue([
      { serverData: { outcome: "discarded", state: null, reason: "withdrawn" } },
    ]);
    const transport = createUploadThingTransport({ siteUrl: "https://partybooth.test" });

    await expect(send(transport)).rejects.toMatchObject({
      name: "UploadCompletionError",
      permanent: true,
      reason: "withdrawn",
    } satisfies Partial<UploadCompletionError>);
  });

  it("fails closed when the provider returns malformed serverData", async () => {
    sdk.uploadFiles.mockResolvedValue([{ serverData: { outcome: "surprise" } }]);
    const transport = createUploadThingTransport({ siteUrl: "https://partybooth.test" });

    await expect(send(transport)).rejects.toThrow();
  });
});
