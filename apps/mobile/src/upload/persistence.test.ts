import { describe, expect, it } from "vitest";

import { DEFAULT_UNDO_DELAY_MS } from "./countdown";
import {
  parseQueue,
  parseQueueItem,
  QUEUE_FORMAT_VERSION,
  relocateQueueCaptureUris,
  serialiseQueue,
} from "./persistence";
import { queueItemFromDraft, queueReducer } from "./queue-reducer";
import { EMPTY_QUEUE, type CaptureDraft, type QueueItem } from "./types";

/**
 * Persistence is tested through an **in-memory store** rather than through
 * `expo-file-system`: what can go wrong is the format, not the write. A test
 * that mocked the native module would prove the mock works.
 */
function createMemoryStore() {
  const files = new Map<string, string>();
  return {
    read: (name: string): string | null => files.get(name) ?? null,
    write: (name: string, contents: string): void => {
      files.set(name, contents);
    },
    /** Simulate a force-quit: whatever was last written is all that survives. */
    corrupt: (name: string, contents: string): void => {
      files.set(name, contents);
    },
  };
}

const T0 = 1_700_000_000_000;
const QUEUE_FILE = "queue.json";

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    captureId: "capture0001",
    eventId: "event1",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/capture0001-original.jpg",
    previewUri: "file:///captures/capture0001-preview.jpg",
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "b".repeat(64),
    width: 3000,
    height: 4000,
    capturedAt: T0,
    sourceMetadataStripped: true,
    ...overrides,
  };
}

function item(overrides: Partial<CaptureDraft> = {}): QueueItem {
  return queueItemFromDraft(draft(overrides), { autoSend: true, undoDelayMs: 15_000 }, T0);
}

describe("a restart", () => {
  it("brings back everything that mattered", () => {
    const store = createMemoryStore();
    const original: QueueItem = { ...item(), ownerUserId: "user_a" };

    store.write(QUEUE_FILE, serialiseQueue([original]));
    const restored = parseQueue(store.read(QUEUE_FILE));

    expect(restored).toEqual([original]);
  });

  it("keeps account ownership and treats a pre-ownership row as legacy", () => {
    const owned: QueueItem = { ...item(), ownerUserId: "user_a" };
    expect(parseQueue(serialiseQueue([owned]))[0]?.ownerUserId).toBe("user_a");

    const { ownerUserId: _ownerUserId, ...legacy } = owned;
    expect(parseQueueItem(legacy)?.ownerUserId).toBeUndefined();
  });

  it("re-queues a capture the previous process left uploading", () => {
    // The full round trip the app performs on cold start: write mid-flight,
    // read back, hydrate. Nothing is actually in flight after a restart, so the
    // row has to be runnable again rather than stuck showing a progress bar.
    const store = createMemoryStore();
    const inFlight: QueueItem = { ...item(), state: "uploading", progress: 0.55, attempts: 2 };
    store.write(QUEUE_FILE, serialiseQueue([inFlight]));

    const state = queueReducer(EMPTY_QUEUE, {
      type: "hydrate",
      items: parseQueue(store.read(QUEUE_FILE)),
      now: T0 + 90_000,
    });

    expect(state.hydrated).toBe(true);
    expect(state.items[0]?.state).toBe("queued");
    expect(state.items[0]?.progress).toBe(0);
    // The attempt genuinely happened; forgetting it would restart the ladder.
    expect(state.items[0]?.attempts).toBe(2);
  });

  it("keeps the checksum byte for byte", () => {
    // A grant is bound to this exact hash. A round trip that mangled it would
    // produce an upload the server refuses at completion, and the guest would
    // see a photo fail forever for no visible reason.
    const store = createMemoryStore();
    const checksum = "0123456789abcdef".repeat(4);
    store.write(QUEUE_FILE, serialiseQueue([item({ checksum })]));
    expect(parseQueue(store.read(QUEUE_FILE))[0]?.checksum).toBe(checksum);
  });

  it("rebases PartyBooth files when iOS changes the app-container UUID", () => {
    const previous = "file:///old-container/Documents/partybooth/captures/capture0001-original.jpg";
    const previousPreview =
      "file:///old-container/Documents/partybooth/captures/capture0001-preview.jpg";
    const previousDerivative =
      "file:///old-container/Documents/partybooth/captures/capture0001-preview-derivative.jpg";
    const queued: QueueItem = {
      ...item({ uri: previous, previewUri: previousPreview }),
      derivatives: [
        {
          role: "preview",
          state: "pending",
          uri: previousDerivative,
          byteSize: 100,
          mimeType: "image/jpeg",
          checksum: "c".repeat(64),
          attempts: 0,
          nextAttemptAt: 0,
        },
      ],
    };

    const [relocated] = relocateQueueCaptureUris(
      [queued],
      (fileName) => `file:///current-container/Documents/partybooth/captures/${fileName}`,
    );

    expect(relocated?.uri).toContain("/current-container/");
    expect(relocated?.previewUri).toContain("/current-container/");
    expect(relocated?.derivatives[0]?.uri).toContain("/current-container/");
  });

  it("does not rewrite a file outside PartyBooth's captures directory", () => {
    const external = "file:///Documents/elsewhere/photo.jpg";
    const [relocated] = relocateQueueCaptureUris(
      [item({ uri: external, previewUri: external })],
      (fileName) => `file:///current/${fileName}`,
    );

    expect(relocated?.uri).toBe(external);
    expect(relocated?.previewUri).toBe(external);
  });
});

describe("an unreadable file", () => {
  const store = createMemoryStore();

  it.each([
    ["absent", null],
    ["empty", ""],
    ["not JSON", "{{{"],
    ["an array", "[]"],
    ["a bare number", "42"],
    ["the wrong version", JSON.stringify({ version: QUEUE_FORMAT_VERSION + 1, items: [] })],
    ["items that are not an array", JSON.stringify({ version: QUEUE_FORMAT_VERSION, items: 3 })],
  ])("reads %s as an empty queue rather than throwing", (_label, contents) => {
    if (contents !== null) store.corrupt(QUEUE_FILE, contents);
    expect(parseQueue(contents)).toEqual([]);
  });
});

describe("one bad row", () => {
  it("does not take the good ones with it", () => {
    // The whole point of per-item parsing: a guest with nine good captures and
    // one row from a build that spelled a field differently keeps the nine.
    const good = item();
    const raw = JSON.stringify({
      version: QUEUE_FORMAT_VERSION,
      items: [good, { captureId: "broken" }, { ...good, captureId: "capture0002" }],
    });
    const restored = parseQueue(raw);
    expect(restored.map((entry) => entry.captureId)).toEqual(["capture0001", "capture0002"]);
  });
});

describe("parseQueueItem", () => {
  const good = item();

  it.each([
    ["captureId", { captureId: "" }],
    ["eventId", { eventId: "" }],
    ["uri", { uri: "" }],
    ["mimeType", { mimeType: "" }],
    ["checksum", { checksum: "" }],
    ["byteSize", { byteSize: 0 }],
    ["capturedAt", { capturedAt: "yesterday" }],
    ["state", { state: "halfway" }],
    ["mediaType", { mediaType: "audio" }],
    ["mediaSource", { mediaSource: "airdrop" }],
  ])("rejects a row with an unusable %s", (_field, overrides) => {
    expect(parseQueueItem({ ...good, ...overrides })).toBeNull();
  });

  it("rejects anything that is not an object", () => {
    for (const value of [null, undefined, 7, "row", []]) {
      expect(parseQueueItem(value)).toBeNull();
    }
  });

  it("falls back rather than failing on the cosmetic fields", () => {
    const { previewUri: _preview, progress: _progress, ...rest } = good;
    const parsed = parseQueueItem(rest);
    // A lost thumbnail is cosmetic; the original is what gets sent.
    expect(parsed?.previewUri).toBe(good.uri);
    expect(parsed?.progress).toBe(0);
  });

  it("treats a row from before auto-send existed as auto-send", () => {
    // It is the only thing the app could produce at the time.
    const { autoSend: _autoSend, ...rest } = good;
    expect(parseQueueItem(rest)?.autoSend).toBe(true);
  });

  it("rebuilds a missing send time from the capture time and the delay", () => {
    const { sendAt: _sendAt, ...rest } = good;
    expect(parseQueueItem({ ...rest, undoDelayMs: DEFAULT_UNDO_DELAY_MS })?.sendAt).toBe(
      T0 + DEFAULT_UNDO_DELAY_MS,
    );
  });

  it("clamps a progress value that escaped its range", () => {
    expect(parseQueueItem({ ...good, progress: 4 })?.progress).toBe(1);
    expect(parseQueueItem({ ...good, progress: -1 })?.progress).toBe(0);
  });

  it("drops a failure with no message and keeps one with", () => {
    expect(parseQueueItem({ ...good, failure: { permanent: true } })?.failure).toBeUndefined();
    expect(parseQueueItem({ ...good, failure: { message: "Too big." } })?.failure).toEqual({
      message: "Too big.",
      permanent: false,
    });
  });
});
