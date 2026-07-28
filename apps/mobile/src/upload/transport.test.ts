import { buildUploadTicket, uploadTicketSchema } from "@partybooth/contracts/upload";
import { describe, expect, it } from "vitest";

import {
  createFakeTransport,
  isAborted,
  isUploadCancelled,
  UploadCancelledError,
  type UploadRequest,
} from "./transport";

/**
 * The regression this file exists for.
 *
 * `apps/mobile` used to send `{ secret }` as the route's input while
 * `apps/web`'s `.middleware()` parsed the full `uploadTicketSchema`. Both sides
 * were reasonable in isolation and neither imported the other, so nothing caught
 * it — every upload from the app would have been refused by the route handler's
 * own input validation before a byte moved, and the first sign of it would have
 * been at a party.
 *
 * The shape now has one definition. These tests assert that what this app puts
 * on the wire is what the route handler parses, using the very same schema.
 */

const GRANT = {
  outcome: "granted",
  grantId: "grant_1",
  secret: "s".repeat(32),
  eventId: "event_1",
  captureId: "mdeadbeefdeadbeefdeadbeefdeadbeef",
  mediaType: "photo",
  mediaSource: "capture",
  storageRegion: "pdx1",
  byteSize: 1_000,
  maxBytes: 20 * 1024 * 1024,
  expiresAt: 1_800_000_120_000,
} as const;

const TICKET = buildUploadTicket(GRANT, {
  mimeType: "image/jpeg",
  checksum: "a".repeat(64),
  width: 4096,
  height: 3072,
});

function request(overrides: Partial<UploadRequest> = {}): UploadRequest {
  return {
    file: {
      uri: "file:///documents/mdeadbeef-original.jpg",
      name: "mdeadbeefdeadbeefdeadbeefdeadbeef-original.jpg",
      mimeType: "image/jpeg",
      byteSize: 1_000,
    },
    ticket: TICKET,
    ...overrides,
  };
}

describe("the ticket this app puts on the wire", () => {
  it("is what apps/web's middleware parses", () => {
    expect(uploadTicketSchema.safeParse(TICKET).success).toBe(true);
  });

  it("carries far more than the grant secret", () => {
    // The exact fields the route handler reads before it asks Convex anything.
    for (const field of ["secret", "eventId", "captureId", "mediaType", "byteSize", "mimeType"]) {
      expect(TICKET).toHaveProperty(field);
    }
  });

  it("describes the file that was authorised, not the queue row's copy of it", () => {
    const drifted = buildUploadTicket(GRANT, {
      mimeType: "image/jpeg",
      checksum: "b".repeat(64),
    });
    expect(drifted.byteSize).toBe(GRANT.byteSize);
    expect(drifted.captureId).toBe(GRANT.captureId);
    expect(drifted.eventId).toBe(GRANT.eventId);
  });

  it("survives the trip through a transport unchanged", async () => {
    const transport = createFakeTransport();
    await transport.upload(request());
    expect(transport.requests[0]?.ticket).toEqual(TICKET);
    expect(uploadTicketSchema.safeParse(transport.requests[0]?.ticket).success).toBe(true);
  });
});

describe("createFakeTransport", () => {
  it("counts attempts per capture, so a retry test can assert the ladder", async () => {
    const transport = createFakeTransport();
    await transport.upload(request());
    await transport.upload(request());
    expect(transport.attemptsFor(GRANT.captureId)).toBe(2);
    expect(transport.attemptsFor("someone-elses-capture")).toBe(0);
  });

  it("emits the progress it was told to, in order", async () => {
    const seen: number[] = [];
    const transport = createFakeTransport({ progress: [0.25, 0.5, 1] });
    await transport.upload(request({ onProgress: (fraction) => seen.push(fraction) }));
    expect(seen).toEqual([0.25, 0.5, 1]);
  });

  it("refuses a request that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createFakeTransport();
    await expect(transport.upload(request({ signal: controller.signal }))).rejects.toBeInstanceOf(
      UploadCancelledError,
    );
  });

  it("can be told to fail, which is the point of testing a retry ladder", async () => {
    const transport = createFakeTransport({
      respond: (_request, attempt) => {
        if (attempt < 3) throw new Error("network");
        return "ok";
      },
    });
    await expect(transport.upload(request())).rejects.toThrow("network");
    await expect(transport.upload(request())).rejects.toThrow("network");
    await expect(transport.upload(request())).resolves.toBeUndefined();
  });
});

describe("cancellation", () => {
  it("recognises our own error and the SDK's two names for it", () => {
    expect(isUploadCancelled(new UploadCancelledError())).toBe(true);
    expect(isUploadCancelled({ name: "AbortError" })).toBe(true);
    expect(isUploadCancelled({ name: "UploadAbortedError" })).toBe(true);
  });

  it("does not mistake a real failure for a cancel", () => {
    expect(isUploadCancelled(new Error("network"))).toBe(false);
    expect(isUploadCancelled(null)).toBe(false);
    expect(isUploadCancelled("aborted")).toBe(false);
  });

  it("reads the signal every time rather than narrowing it once", () => {
    const controller = new AbortController();
    expect(isAborted(controller.signal)).toBe(false);
    controller.abort();
    expect(isAborted(controller.signal)).toBe(true);
    expect(isAborted(undefined)).toBe(false);
  });
});
