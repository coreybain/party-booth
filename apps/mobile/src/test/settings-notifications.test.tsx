/**
 * Settings → Notifications: the toggles are really wired to the backend.
 *
 * Two behaviours here are easy to get subtly wrong and impossible to notice:
 *
 * - **Only the field that moved is sent.** Preferences are one row, and a
 *   settings screen that posts the whole object lets two phones open on the same
 *   account revert each other's untouched choices.
 * - **The host toggle is conditional on hosting something.** A dead switch is
 *   worse than no switch, and `hostPendingThreshold` means nothing to a guest.
 *
 * The screen, the contracts copy and the layout primitives are real; Convex, the
 * session and the push provider are faked.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const fake = vi.hoisted(() => ({
  preferences: undefined as unknown,
  updatePreferences: vi.fn(),
  session: {} as Record<string, unknown>,
  enableNotifications: vi.fn(),
  permission: "granted" as string,
  emails: [] as unknown[],
  requestVerification: vi.fn(),
  confirmVerification: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (reference: { name: string }) => {
    if (reference.name === "preferences") return fake.preferences;
    if (reference.name === "myEmails") return fake.emails;
    return undefined;
  },
  useAction: (reference: { name: string }) =>
    reference.name === "requestVerification" ? fake.requestVerification : vi.fn(),
  useMutation: (reference: { name: string }) => {
    if (reference.name === "updatePreferences") return fake.updatePreferences;
    if (reference.name === "confirmVerification") return fake.confirmVerification;
    return vi.fn();
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    api: {
      users: { requestAccountDeletion: { name: "requestAccountDeletion" } },
      emails: {
        myEmails: { name: "myEmails" },
        requestVerification: { name: "requestVerification" },
        confirmVerification: { name: "confirmVerification" },
      },
      blocks: { unblock: { name: "unblock" }, myBlocks: { name: "myBlocks" } },
      push: {
        preferences: { name: "preferences" },
        updatePreferences: { name: "updatePreferences" },
      },
    },
  };
});

vi.mock("@/env", () => ({
  appConfig: {
    status: "ready",
    siteUrl: "https://partybooth.example",
    features: { sentry: false, push: true },
  },
}));

vi.mock("@/push/provider", () => ({
  usePush: () => ({
    permission: fake.permission,
    step: "register",
    registered: true,
    armPrompt: vi.fn(),
    enableNotifications: fake.enableNotifications,
  }),
}));

vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/lib/sentry", () => ({
  captureHandledError: vi.fn(),
  isSentryEnabled: () => false,
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("expo-image", () => ({ Image: () => createElement("img", { alt: "avatar" }) }));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

function aSession(events: { role: string }[]) {
  return {
    state: { status: "signed-in", user: { id: "u1", name: "Sam", email: "sam@example.com" } },
    configured: true,
    signOut: vi.fn(),
    previewEventRole: null,
    setPreviewEventRole: vi.fn(),
    activeEvent: null,
    events,
  };
}

async function renderSettings() {
  const { default: SettingsScreen } = await import("../../app/(tabs)/settings");
  render(createElement(SettingsScreen));
}

beforeEach(() => {
  fake.permission = "granted";
  fake.preferences = {
    categories: ["uploadStatus", "eventLifecycle", "hostPendingThreshold"],
    optOut: [],
    pendingThreshold: 5,
    defaultPendingThreshold: 5,
  };
  fake.session = aSession([{ role: "guest" }]);
  fake.updatePreferences.mockReset().mockResolvedValue({ optOut: [], pendingThreshold: 5 });
  fake.enableNotifications.mockReset();
  fake.emails = [];
  fake.requestVerification.mockReset().mockResolvedValue(null);
  fake.confirmVerification.mockReset().mockResolvedValue({
    ok: true,
    organiserUnlocked: false,
    cohostEventIds: [],
  });
});

describe("notification categories", () => {
  it("renders a toggle per category the server knows about", async () => {
    await renderSettings();
    expect(screen.getByLabelText("Upload problems")).toBeTruthy();
    expect(screen.getByLabelText("Party opened or closed")).toBeTruthy();
  });

  it("sends only the opt-out list when a toggle moves", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Upload problems"));

    await waitFor(() => {
      expect(fake.updatePreferences).toHaveBeenCalledWith({ optOut: ["uploadStatus"] });
    });
  });

  it("switches one back on without disturbing the others", async () => {
    fake.preferences = {
      categories: ["uploadStatus", "eventLifecycle", "hostPendingThreshold"],
      optOut: ["uploadStatus", "eventLifecycle"],
      pendingThreshold: 5,
      defaultPendingThreshold: 5,
    };
    await renderSettings();

    fireEvent.click(screen.getByLabelText("Upload problems"));
    await waitFor(() => {
      expect(fake.updatePreferences).toHaveBeenCalledWith({ optOut: ["eventLifecycle"] });
    });
  });

  it("hides the host category from somebody who hosts nothing", async () => {
    await renderSettings();
    expect(screen.queryByLabelText("Photos waiting for you")).toBeNull();
    expect(screen.queryByLabelText(/Notify me at 5 waiting/i)).toBeNull();
  });

  it("shows it, and the threshold, to a co-host", async () => {
    fake.session = aSession([{ role: "guest" }, { role: "cohost" }]);
    await renderSettings();

    expect(screen.getByLabelText("Photos waiting for you")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Notify me at 20 waiting/i));
    await waitFor(() => {
      expect(fake.updatePreferences).toHaveBeenCalledWith({ pendingThreshold: 20 });
    });
  });
});

describe("permission state", () => {
  it("offers the prompt when it has not been asked yet", async () => {
    fake.permission = "undetermined";
    await renderSettings();

    fireEvent.click(screen.getByLabelText(/Turn on notifications/i));
    expect(fake.enableNotifications).toHaveBeenCalled();
  });

  it("points a refusal at the system settings instead of a dead button", async () => {
    // iOS will not show the prompt twice. Offering it again would do nothing at
    // all, which is the most frustrating possible control.
    fake.permission = "denied";
    await renderSettings();

    expect(screen.getByLabelText(/Open phone settings/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Turn on notifications/i)).toBeNull();
  });

  it("says so when the build has no Expo project at all", async () => {
    vi.resetModules();
    vi.doMock("@/env", () => ({
      appConfig: {
        status: "ready",
        siteUrl: "https://partybooth.example",
        features: { sentry: false, push: false },
      },
    }));

    await renderSettings();
    expect(screen.getByText(/no Expo project configured/i)).toBeTruthy();
    vi.doUnmock("@/env");
    vi.resetModules();
  });
});
