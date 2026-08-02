import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const TOKEN = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

const fake = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  requestPermission: vi.fn(),
  permission: { granted: true, canAskAgain: true } as {
    granted: boolean;
    canAskAgain: boolean;
  } | null,
  isDevice: true,
  onBarcodeScanned: undefined as ((result: { data: string }) => void) | undefined,
  session: {
    events: [] as unknown[],
    activeEvent: null,
    eventsLoading: false,
    configured: true,
    selectEvent: vi.fn(),
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: fake.push, replace: fake.replace, back: vi.fn() }),
}));

vi.mock("expo-camera", () => ({
  useCameraPermissions: () => [fake.permission, fake.requestPermission, fake.requestPermission],
  CameraView: (props: Record<string, unknown>) => {
    fake.onBarcodeScanned = props.onBarcodeScanned as typeof fake.onBarcodeScanned;
    const settings = props.barcodeScannerSettings as { barcodeTypes?: string[] } | undefined;
    return createElement("div", {
      "data-testid": "qr-camera",
      "data-barcode-types": settings?.barcodeTypes?.join(",") ?? "",
    });
  },
}));

vi.mock("expo-device", () => ({
  get isDevice() {
    return fake.isDevice;
  },
}));

vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.UTC(2026, 7, 5, 20, 0, 0) }));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

beforeEach(() => {
  fake.permission = { granted: true, canAskAgain: true };
  fake.isDevice = true;
  fake.onBarcodeScanned = undefined;
  fake.session.events = [];
  fake.session.eventsLoading = false;
  fake.session.configured = true;
});

describe("Your parties join actions", () => {
  it("shows both QR scanning and code entry when there are no parties", async () => {
    const { default: EventsRoute } = await import("../../app/events");
    render(createElement(EventsRoute));

    expect(screen.getByText("You haven't joined a party yet")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Scan a QR code"));
    expect(fake.push).toHaveBeenCalledWith("/join/scan");

    fireEvent.click(screen.getByLabelText("Enter a join code"));
    expect(fake.push).toHaveBeenCalledWith("/join");
  });
});

describe("party QR scanner", () => {
  it("mounts a QR-only camera and forwards a valid invite to the existing join route", async () => {
    const { default: ScanJoinRoute } = await import("../../app/join/scan");
    render(createElement(ScanJoinRoute));

    expect(screen.getByTestId("qr-camera").getAttribute("data-barcode-types")).toBe("qr");

    const onBarcodeScanned = fake.onBarcodeScanned;
    expect(onBarcodeScanned).toBeTypeOf("function");

    act(() => {
      onBarcodeScanned?.({ data: `https://partybooth.app/join/${TOKEN}` });
      onBarcodeScanned?.({ data: `https://partybooth.app/join/${TOKEN}` });
    });

    expect(fake.replace).toHaveBeenCalledOnce();
    expect(fake.replace).toHaveBeenCalledWith({
      pathname: "/join/[token]",
      params: { token: TOKEN },
    });
  });

  it("refuses an unrelated QR and lets the user scan again", async () => {
    const { default: ScanJoinRoute } = await import("../../app/join/scan");
    render(createElement(ScanJoinRoute));

    act(() => {
      fake.onBarcodeScanned?.({ data: "https://example.com/not-a-party" });
    });

    expect(screen.getByText("That QR code is not a PartyBooth invite.")).toBeTruthy();
    expect(fake.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Scan again"));
    expect(screen.queryByText("That QR code is not a PartyBooth invite.")).toBeNull();
  });
});
