/**
 * The Camera tab actually mounts a camera.
 *
 * Sprint 3 shipped `use-capture`, `camera-controls` and `undo-pill` fully
 * unit-tested and imported by nothing: the tab still rendered the Sprint 2
 * placeholder, and every test in the package was green. These assertions are
 * the ones that would have gone red.
 *
 * Only the native leaves are faked — the camera module, the picker, the device
 * check, the queue and the session. The screen, the controls, the undo pill and
 * the layout primitives are the real ones, running under `react-native-web`
 * (see `vitest.config.ts`).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, forwardRef, useEffect, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "@/lib/api";
import type { QueueItem } from "@/upload/types";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 7, 5, 21, 0, 0);

const fake = vi.hoisted(() => ({
  isDevice: true,
  permission: null as { granted: boolean; canAskAgain: boolean } | null,
  requestPermission: vi.fn(),
  takePictureAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  openSettings: vi.fn(),
  capture: vi.fn(),
  captureBusy: false,
  push: vi.fn(),
  focused: true,
  session: {} as Record<string, unknown>,
  queue: {} as Record<string, unknown>,
}));

vi.mock("expo-camera", () => ({
  useCameraPermissions: () => [fake.permission, fake.requestPermission, fake.requestPermission],
  // A stand-in that records the props the screen chose and exposes the one
  // imperative method the shutter calls.
  CameraView: forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    useImperativeHandle(ref, () => ({ takePictureAsync: fake.takePictureAsync }));
    const onCameraReady = props.onCameraReady as (() => void) | undefined;
    useEffect(() => {
      onCameraReady?.();
    }, [onCameraReady]);
    return createElement("div", {
      "data-testid": "camera-view",
      "data-facing": String(props.facing),
      "data-flash": String(props.flash),
      "data-mode": String(props.mode),
      "data-active": String(props.active),
    });
  }),
}));

vi.mock("expo-device", () => ({
  get isDevice() {
    return fake.isDevice;
  },
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: unknown[]) => fake.launchImageLibraryAsync(...args),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: fake.push, replace: vi.fn(), back: vi.fn() }),
  useIsFocused: () => fake.focused,
}));

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) =>
    createElement("img", {
      "data-testid": "expo-image",
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

vi.mock("@/hooks/use-capture", () => ({
  useCapture: () => ({ busy: fake.captureBusy, capture: fake.capture }),
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

function anUndoableItem(): QueueItem {
  return {
    captureId: "m_1",
    eventId: "event_1",
    state: "captured",
    mediaType: "photo",
    mediaSource: "capture",
    uri: "file:///captures/m_1.jpg",
    previewUri: "file:///captures/m_1-preview.jpg",
    byteSize: 2_000_000,
    mimeType: "image/jpeg",
    checksum: "a".repeat(64),
    capturedAt: NOW,
    sourceMetadataStripped: true,
    autoSend: true,
    sendAt: NOW + 15_000,
    undoDelayMs: 15_000,
    attempts: 0,
    nextAttemptAt: NOW + 15_000,
    progress: 0,
    updatedAt: NOW,
  };
}

async function renderCamera() {
  const { default: CameraScreen } = await import("../../app/(tabs)/camera");
  return render(createElement(CameraScreen));
}

beforeEach(() => {
  fake.isDevice = true;
  fake.focused = true;
  fake.permission = { granted: true, canAskAgain: true };
  fake.captureBusy = false;
  fake.takePictureAsync.mockResolvedValue({
    uri: "file:///tmp/frame.jpg",
    width: 4032,
    height: 3024,
  });
  fake.capture.mockResolvedValue({ status: "queued", item: anUndoableItem() });
  fake.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
  fake.session = { activeEvent: anEvent(), eventsLoading: false };
  fake.queue = {
    offline: false,
    pendingFor: () => 0,
    undoableFor: () => undefined,
    itemsFor: () => [],
    undo: vi.fn(),
    sendNow: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  };
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("CameraScreen — the viewfinder is mounted", () => {
  it("renders a real CameraView in picture mode", async () => {
    await renderCamera();

    const view = screen.getByTestId("camera-view");
    expect(view).toBeTruthy();
    // Video is Sprint 4; a `video` mode here would silently change what the
    // shutter does.
    expect(view.getAttribute("data-mode")).toBe("picture");
    expect(view.getAttribute("data-facing")).toBe("back");
    expect(view.getAttribute("data-flash")).toBe("off");
  });

  it("no longer renders the Sprint 2 placeholder", async () => {
    await renderCamera();
    expect(screen.queryByText(/Viewfinder lands in Sprint 3/i)).toBeNull();
  });

  it("stops the camera session when the tab is not focused", async () => {
    // A live capture session behind another tab is battery and a hot phone for a
    // preview nobody is looking at — and it is invisible in review.
    await renderCamera();
    expect(screen.getByTestId("camera-view").getAttribute("data-active")).toBe("true");

    cleanup();
    fake.focused = false;
    await renderCamera();
    expect(screen.getByTestId("camera-view").getAttribute("data-active")).toBe("false");
  });

  it("cycles the flash off → auto → on → off", async () => {
    await renderCamera();
    const view = () => screen.getByTestId("camera-view").getAttribute("data-flash");

    expect(view()).toBe("off");
    fireEvent.click(screen.getByLabelText("Flash off"));
    expect(view()).toBe("auto");
    fireEvent.click(screen.getByLabelText("Flash automatic"));
    expect(view()).toBe("on");
    fireEvent.click(screen.getByLabelText("Flash on"));
    expect(view()).toBe("off");
  });

  it("flips between the back and front camera", async () => {
    await renderCamera();
    const label = "Switch between the front and back camera";

    expect(screen.getByTestId("camera-view").getAttribute("data-facing")).toBe("back");
    fireEvent.click(screen.getByLabelText(label));
    expect(screen.getByTestId("camera-view").getAttribute("data-facing")).toBe("front");
    fireEvent.click(screen.getByLabelText(label));
    expect(screen.getByTestId("camera-view").getAttribute("data-facing")).toBe("back");
  });
});

describe("CameraScreen — the shutter", () => {
  it("takes a picture and hands the frame to the capture pipeline", async () => {
    await renderCamera();

    fireEvent.click(screen.getByLabelText("Take a photo"));

    await waitFor(() => {
      expect(fake.takePictureAsync).toHaveBeenCalledTimes(1);
    });

    // EXIF is dropped at the source as well as by the re-encode.
    expect(fake.takePictureAsync.mock.calls[0]?.[0]).toMatchObject({ exif: false });

    await waitFor(() => {
      expect(fake.capture).toHaveBeenCalledTimes(1);
    });
    expect(fake.capture.mock.calls[0]?.[0]).toMatchObject({
      fromLibrary: false,
      source: { uri: "file:///tmp/frame.jpg", width: 4032, height: 3024 },
    });
  });

  it("shows a refusal from the contract verbatim", async () => {
    // Refusals are values, not exceptions (ADR 0004 §2), and arrive pre-worded.
    fake.capture.mockResolvedValue({
      status: "refused",
      message: "The host paused this party.",
    });
    await renderCamera();

    fireEvent.click(screen.getByLabelText("Take a photo"));

    await waitFor(() => {
      expect(screen.getByText("The host paused this party.")).toBeTruthy();
    });
  });

  it("says what the hold gesture will do, rather than letting it do nothing", async () => {
    // A guest will try holding for video. Silence reads as a broken button, and
    // an `accessibilityHint` only ever reaches a screen reader.
    const { SHUTTER_HINT } = await import("../../app/(tabs)/camera");
    await renderCamera();

    expect(screen.getByLabelText("Take a photo")).toBeTruthy();
    expect(screen.getByText(SHUTTER_HINT)).toBeTruthy();
  });

  it("is disabled when the party is not taking photographs", async () => {
    fake.session = { activeEvent: anEvent({ state: "paused" }), eventsLoading: false };
    await renderCamera();

    expect(screen.getByLabelText("Take a photo").getAttribute("aria-disabled")).toBe("true");
    // And says why, in the contract's own words.
    expect(screen.getByText(/paused submissions/i)).toBeTruthy();
  });
});

describe("CameraScreen — the library button", () => {
  it("is hidden when the host has library imports switched off", async () => {
    await renderCamera();
    expect(screen.queryByLabelText("Add a photo from your library")).toBeNull();
  });

  it("appears when the event's flag allows it, and opens the picker", async () => {
    fake.session = {
      activeEvent: anEvent({ allowLibraryImport: true }),
      eventsLoading: false,
    };
    fake.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///photos/IMG_1.HEIC", width: 3024, height: 4032 }],
    });

    await renderCamera();

    fireEvent.click(screen.getByLabelText("Add a photo from your library"));

    await waitFor(() => {
      expect(fake.capture).toHaveBeenCalledTimes(1);
    });
    // `fromLibrary` is what makes `checkGrantEligibility` apply the per-event
    // import permission, and what stops the picked file being deleted.
    expect(fake.capture.mock.calls[0]?.[0]).toMatchObject({
      fromLibrary: true,
      source: { uri: "file:///photos/IMG_1.HEIC" },
    });
  });

  it("does nothing when the guest backs out of the picker", async () => {
    fake.session = { activeEvent: anEvent({ allowLibraryImport: true }), eventsLoading: false };
    await renderCamera();

    fireEvent.click(screen.getByLabelText("Add a photo from your library"));

    await waitFor(() => {
      expect(fake.launchImageLibraryAsync).toHaveBeenCalled();
    });
    expect(fake.capture).not.toHaveBeenCalled();
  });
});

describe("CameraScreen — the undo window", () => {
  it("shows the countdown for the capture that is still undoable", async () => {
    const item = anUndoableItem();
    const undo = vi.fn();
    const sendNow = vi.fn();
    fake.queue = { ...fake.queue, undoableFor: () => item, undo, sendNow, pendingFor: () => 2 };

    await renderCamera();

    expect(screen.getByLabelText("Undo")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Undo"));
    expect(undo).toHaveBeenCalledWith("m_1");

    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendNow).toHaveBeenCalledWith("m_1");
  });

  it("shows how many captures are still on their way", async () => {
    fake.queue = { ...fake.queue, pendingFor: () => 3 };
    await renderCamera();
    expect(screen.getByText("3 sending")).toBeTruthy();
  });
});

describe("CameraScreen — the states that are not a viewfinder", () => {
  it("asks for the camera before it has been granted", async () => {
    fake.permission = { granted: false, canAskAgain: true };
    await renderCamera();

    expect(screen.queryByTestId("camera-view")).toBeNull();
    fireEvent.click(screen.getByText("Allow the camera"));
    expect(fake.requestPermission).toHaveBeenCalled();
  });

  it("points at system Settings once the OS will not ask again", async () => {
    fake.permission = { granted: false, canAskAgain: false };
    await renderCamera();

    expect(screen.getByText(/only ask once/i)).toBeTruthy();
    expect(screen.queryByText("Allow the camera")).toBeNull();
  });

  it("waits rather than flashing the prompt while the OS is still answering", async () => {
    // `null` is "not read yet". Rendering the prompt during that beat would show
    // it to every guest who has already granted it, on every cold start.
    fake.permission = null;
    await renderCamera();

    expect(screen.getByText(/Getting the camera ready/i)).toBeTruthy();
    expect(screen.queryByText("Allow the camera")).toBeNull();
  });

  it("explains itself on a simulator instead of drawing a black rectangle", async () => {
    fake.isDevice = false;
    fake.session = { activeEvent: anEvent({ allowLibraryImport: true }), eventsLoading: false };
    await renderCamera();

    expect(screen.queryByTestId("camera-view")).toBeNull();
    expect(screen.getByText(/No camera here/i)).toBeTruthy();
    // The library path still works there, which is how the upload spine gets
    // exercised without a physical device.
    expect(screen.getByLabelText("Add a photo from your library")).toBeTruthy();
    expect(screen.getByLabelText("Take a photo").getAttribute("aria-disabled")).toBe("true");
  });

  it("sends a guest with no party to the join screen", async () => {
    fake.session = { activeEvent: null, eventsLoading: false };
    await renderCamera();

    expect(screen.queryByTestId("camera-view")).toBeNull();
    fireEvent.click(screen.getByText("Enter a join code"));
    expect(fake.push).toHaveBeenCalledWith("/join");
  });

  it("says so when the build has no backend to send to", async () => {
    fake.queue = { ...fake.queue, offline: true };
    await renderCamera();
    expect(screen.getByText(/kept on this phone and never uploaded/i)).toBeTruthy();
  });
});
