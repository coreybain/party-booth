/**
 * The Photos tab actually shows media.
 *
 * `media.myMedia` and `media.withdraw` were live on the backend and wired on the
 * web guest page while this tab still rendered two empty states. These are the
 * assertions that would have caught that: a merged list, the actions each state
 * permits, a withdrawal that asks before it deletes, and an approved-only
 * gallery.
 *
 * Convex, the queue, the session and the image component are faked. The screen,
 * `mergeMediaTimeline` and the layout primitives are real.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary, MediaItem } from "@/lib/api";
import type { QueueItem } from "@/upload/types";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 7, 5, 21, 0, 0);

const fake = vi.hoisted(() => ({
  myMedia: undefined as unknown,
  eventMedia: undefined as unknown,
  withdraw: vi.fn(),
  items: [] as unknown[],
  session: {} as Record<string, unknown>,
  queue: {} as Record<string, unknown>,
}));

// `useQuery` is dispatched on which function reference it was handed, exactly as
// Convex does — so a screen that asked for the wrong query fails here rather
// than silently rendering the other list.
vi.mock("convex/react", () => ({
  useQuery: (reference: { name: string }, args: unknown) => {
    if (args === "skip") return undefined;
    return reference.name === "myMedia" ? fake.myMedia : fake.eventMedia;
  },
  useMutation: () => fake.withdraw,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    api: {
      media: {
        myMedia: { name: "myMedia" },
        eventMedia: { name: "eventMedia" },
        withdraw: { name: "withdraw" },
      },
    },
  };
});

vi.mock("@/env", () => ({ appConfig: { status: "ready" } }));

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) =>
    createElement("img", {
      "data-testid": "thumbnail",
      "data-uri": String((props.source as { uri?: string } | undefined)?.uri ?? ""),
      alt: String(props.accessibilityLabel ?? "thumbnail"),
    }),
}));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/upload/queue-provider", () => ({ useUploadQueue: () => fake.queue }));
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function anEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "event_1",
    name: "Corey's party",
    state: "live",
    moderationMode: "manual",
    startsAt: NOW,
    timeZone: "Europe/London",
    allowLibraryImport: false,
    storageRegion: "pdx1",
    role: "guest",
    counts: { pending: 0, approved: 0, declined: 0, total: 0 },
    ...overrides,
  };
}

function anItem(overrides: Partial<QueueItem> & { captureId: string }): QueueItem {
  return {
    eventId: "event_1",
    state: "queued",
    mediaType: "photo",
    mediaSource: "capture",
    uri: `file:///captures/${overrides.captureId}.jpg`,
    previewUri: `file:///captures/${overrides.captureId}-preview.jpg`,
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    capturedAt: NOW,
    sourceMetadataStripped: true,
    autoSend: true,
    sendAt: NOW,
    undoDelayMs: 15_000,
    attempts: 0,
    nextAttemptAt: NOW,
    progress: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

function aRow(overrides: Partial<MediaItem> & { id: string; captureId: string }): MediaItem {
  return {
    eventId: "event_1",
    state: "pending",
    mediaType: "photo",
    fromLibrary: false,
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    uploaderUserId: "user_1",
    uploaderDisplayName: "Sam",
    isOwn: true,
    createdAt: NOW,
    ...overrides,
  };
}

async function renderPhotos() {
  const { default: PhotosScreen } = await import("../../app/(tabs)/photos");
  return render(createElement(PhotosScreen));
}

/** The gallery is the second segment; nothing renders it until it is chosen. */
function openGallery() {
  fireEvent.click(screen.getByText("Event gallery"));
}

beforeEach(() => {
  fake.myMedia = [];
  fake.eventMedia = [];
  fake.items = [];
  fake.withdraw.mockResolvedValue({ state: "deleted" });
  fake.session = { activeEvent: anEvent(), eventsLoading: false };
  fake.queue = {
    offline: false,
    itemsFor: () => fake.items,
    pendingFor: () => 0,
    undoableFor: () => undefined,
    retry: vi.fn(),
    cancel: vi.fn(),
  };
});

/* -------------------------------------------------------------------------- */
/* My media                                                                   */
/* -------------------------------------------------------------------------- */

describe("PhotosScreen — My media", () => {
  it("no longer renders only an empty placeholder when there is media", async () => {
    fake.myMedia = [aRow({ id: "media_1", captureId: "w_1", state: "approved" })];
    await renderPhotos();

    expect(screen.queryByText("Nothing sent yet")).toBeNull();
    expect(screen.getByText("ADDED")).toBeTruthy();
  });

  it("waits for the subscription rather than claiming there is nothing", async () => {
    // `undefined` is "not answered yet". An empty state here tells a guest their
    // photographs are gone.
    fake.myMedia = undefined;
    await renderPhotos();

    expect(screen.getByText(/Loading your photos/i)).toBeTruthy();
    expect(screen.queryByText("Nothing sent yet")).toBeNull();
  });

  it("merges an in-flight capture with its server row into one entry", async () => {
    fake.myMedia = [aRow({ id: "media_1", captureId: "m_1", state: "processing" })];
    fake.items = [anItem({ captureId: "m_1", state: "uploading", progress: 0.45 })];
    await renderPhotos();

    // The local row wins while the guest can still act on it, so this reads
    // "SENDING" with a progress bar rather than the server's bare "processing".
    expect(screen.getAllByText("SENDING")).toHaveLength(1);
    const bar = screen.getByLabelText("Upload progress");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect((bar.firstElementChild as HTMLElement | null)?.style.width).toBe("45%");
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("draws the local thumbnail rather than a signed URL while one exists", async () => {
    fake.myMedia = [
      aRow({ id: "media_1", captureId: "m_1", previewUrl: "https://cdn/preview.jpg" }),
    ];
    fake.items = [anItem({ captureId: "m_1", state: "uploading" })];
    await renderPhotos();

    expect(screen.getByTestId("thumbnail").getAttribute("data-uri")).toBe(
      "file:///captures/m_1-preview.jpg",
    );
  });

  it("offers a retry for a failure that a retry could fix", async () => {
    const retry = vi.fn();
    fake.queue = { ...fake.queue, retry };
    fake.items = [
      anItem({
        captureId: "m_1",
        state: "failed",
        failure: { message: "The network dropped.", permanent: false },
      }),
    ];
    await renderPhotos();

    expect(screen.getByText("The network dropped.")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(retry).toHaveBeenCalledWith("m_1");
  });

  it("does not offer a retry that cannot possibly succeed", async () => {
    // A photo refused because the host paused the party is not fixed by a timer
    // or a button, and a button that cannot work is worse than no button.
    fake.items = [
      anItem({
        captureId: "m_1",
        state: "failed",
        failure: { message: "That party is paused.", permanent: true },
      }),
    ];
    await renderPhotos();

    expect(screen.getByText("That party is paused.")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("cancels an upload that is still in flight", async () => {
    const cancel = vi.fn();
    fake.queue = { ...fake.queue, cancel };
    fake.items = [anItem({ captureId: "m_1", state: "queued" })];
    await renderPhotos();

    fireEvent.click(screen.getByText("Cancel"));
    expect(cancel).toHaveBeenCalledWith("m_1");
  });
});

/* -------------------------------------------------------------------------- */
/* Withdrawal                                                                 */
/* -------------------------------------------------------------------------- */

describe("PhotosScreen — withdrawal", () => {
  beforeEach(() => {
    fake.myMedia = [aRow({ id: "media_1", captureId: "w_1", state: "approved" })];
  });

  it("asks before it deletes, and says that deletion is permanent", async () => {
    await renderPhotos();

    fireEvent.click(screen.getByText("Take it back"));

    // ADR 0004 §6: the row goes to `deleted`, unspent grants are expired and the
    // object is purged. None of that is undoable, and the copy has to say so
    // rather than asking "Are you sure?".
    expect(screen.getByText(/deleted for good/i)).toBeTruthy();
    expect(fake.withdraw).not.toHaveBeenCalled();
  });

  it("withdraws once the second tap confirms it", async () => {
    await renderPhotos();

    fireEvent.click(screen.getByText("Take it back"));
    fireEvent.click(screen.getByText("Yes, delete it"));

    await waitFor(() => {
      expect(fake.withdraw).toHaveBeenCalledWith({ mediaId: "media_1" });
    });
  });

  it("backs out without deleting anything", async () => {
    await renderPhotos();

    fireEvent.click(screen.getByText("Take it back"));
    fireEvent.click(screen.getByText("Keep it"));

    expect(fake.withdraw).not.toHaveBeenCalled();
    expect(screen.getByText("Take it back")).toBeTruthy();
  });

  it("shows the failure rather than pretending it worked", async () => {
    fake.withdraw.mockRejectedValue(new Error("Not allowed"));
    await renderPhotos();

    fireEvent.click(screen.getByText("Take it back"));
    fireEvent.click(screen.getByText("Yes, delete it"));

    await waitFor(() => {
      expect(screen.getByText(/That didn't work/i)).toBeTruthy();
    });
  });

  it("never offers to withdraw somebody else's photo", async () => {
    fake.myMedia = [aRow({ id: "media_2", captureId: "w_2", state: "approved", isOwn: false })];
    await renderPhotos();

    expect(screen.queryByText("Take it back")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Event gallery                                                              */
/* -------------------------------------------------------------------------- */

describe("PhotosScreen — Event gallery", () => {
  it("shows a tile for every approved item", async () => {
    fake.eventMedia = [
      aRow({
        id: "media_1",
        captureId: "w_1",
        state: "approved",
        previewUrl: "https://cdn/a.jpg",
        previewUrlExpiresAt: Date.now() + 600_000,
      }),
      aRow({
        id: "media_2",
        captureId: "w_2",
        state: "approved",
        uploaderDisplayName: "Ada",
        url: "https://cdn/b.jpg",
        urlExpiresAt: Date.now() + 600_000,
      }),
    ];
    await renderPhotos();
    openGallery();

    const tiles = screen.getAllByTestId("thumbnail");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.getAttribute("data-uri")).toBe("https://cdn/a.jpg");
    expect(tiles[1]?.getAttribute("data-uri")).toBe("https://cdn/b.jpg");
    expect(screen.getByAltText("Photo from Ada")).toBeTruthy();
  });

  it("draws a placeholder rather than a URL whose signature has expired", async () => {
    // A Convex query re-runs when its data changes, not when the clock moves
    // (ADR 0004 §5), so a gallery left open is holding dead URLs.
    fake.eventMedia = [
      aRow({
        id: "media_1",
        captureId: "w_1",
        state: "approved",
        previewUrl: "https://cdn/a.jpg",
        previewUrlExpiresAt: Date.now() - 1_000,
      }),
    ];
    await renderPhotos();
    openGallery();

    expect(screen.queryByTestId("thumbnail")).toBeNull();
    expect(screen.getByLabelText(/not available yet/i)).toBeTruthy();
  });

  it("waits for the subscription before saying the gallery is empty", async () => {
    fake.eventMedia = undefined;
    await renderPhotos();
    openGallery();

    expect(screen.getByText(/Loading the gallery/i)).toBeTruthy();
    expect(screen.queryByText("No approved media yet")).toBeNull();
  });

  it("says so when the host has approved nothing yet", async () => {
    fake.eventMedia = [];
    await renderPhotos();
    openGallery();

    expect(screen.getByText("No approved media yet")).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* No party, no backend                                                       */
/* -------------------------------------------------------------------------- */

describe("PhotosScreen — nothing to show", () => {
  it("sends a guest with no party to join one", async () => {
    fake.session = { activeEvent: null, eventsLoading: false };
    await renderPhotos();

    expect(screen.getAllByText("Join a party first")).toHaveLength(1);
    openGallery();
    expect(screen.getAllByText("Join a party first")).toHaveLength(1);
  });

  it("waits while the membership subscriptions are still answering", async () => {
    fake.session = { activeEvent: null, eventsLoading: true };
    await renderPhotos();

    expect(screen.getByText(/Finding your parties/i)).toBeTruthy();
    expect(screen.queryByText("Join a party first")).toBeNull();
  });

  it("keeps local captures visible in a build with no backend", async () => {
    // The queue provider is mounted either way, so the captures exist. An empty
    // list here would read as "the photos were lost".
    vi.resetModules();
    vi.doMock("@/env", () => ({ appConfig: { status: "unconfigured", missing: [] } }));
    fake.items = [anItem({ captureId: "m_1", state: "captured" })];

    cleanup();
    await renderPhotos();

    expect(screen.getByText(/Nothing can be sent from this build/i)).toBeTruthy();
    expect(screen.getByText("READY")).toBeTruthy();
    vi.doUnmock("@/env");
    vi.resetModules();
  });
});
