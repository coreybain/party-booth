import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const fake = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  acceptCurrentTerms: vi.fn(),
  replace: vi.fn(),
  openBrowserAsync: vi.fn(),
}));

vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/env", () => ({
  appConfig: {
    status: "ready",
    siteUrl: "https://partybooth.example",
    features: { sentry: false, push: false },
  },
}));
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));
vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => createElement("span", null, `redirect:${href}`),
  useRouter: () => ({ replace: fake.replace }),
}));
vi.mock("expo-web-browser", () => ({
  openBrowserAsync: (...args: unknown[]) => fake.openBrowserAsync(...args),
}));
vi.mock("expo-image", () => ({
  Image: () => createElement("img", { alt: "avatar" }),
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn().mockResolvedValue({ canceled: true, assets: null }),
}));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

function establishedSession() {
  return {
    state: {
      status: "signed-in",
      user: { id: "u1", name: "Sam", email: "sam@example.com", image: null },
      needsOnboarding: false,
      needsTermsAcceptance: true,
    },
    localProfile: { photoUri: null },
    confirmProfile: vi.fn(),
    acceptCurrentTerms: fake.acceptCurrentTerms,
  };
}

beforeEach(() => {
  fake.session = establishedSession();
  fake.acceptCurrentTerms.mockReset().mockResolvedValue({ status: "ok" });
  fake.replace.mockReset();
  fake.openBrowserAsync.mockReset().mockResolvedValue(undefined);
});

async function renderOnboarding() {
  const { default: OnboardingScreen } = await import("../../app/(auth)/onboarding");
  return render(createElement(OnboardingScreen));
}

describe("current-terms recovery", () => {
  it("gives an established account a focused acceptance step", async () => {
    await renderOnboarding();

    expect(screen.getByText(/terms have changed/i)).toBeTruthy();
    expect(screen.queryByLabelText("Display name")).toBeNull();
    fireEvent.click(screen.getByLabelText("Agree and continue"));

    await waitFor(() => {
      expect(fake.acceptCurrentTerms).toHaveBeenCalledTimes(1);
      expect(fake.replace).toHaveBeenCalledWith("/");
    });
  });

  it("opens the published current terms", async () => {
    await renderOnboarding();
    fireEvent.click(screen.getByLabelText("Read the current terms"));

    await waitFor(() => {
      expect(fake.openBrowserAsync).toHaveBeenCalledWith("https://partybooth.example/terms");
    });
  });

  it("shows a server failure and does not leave the gate", async () => {
    fake.acceptCurrentTerms.mockResolvedValue({
      status: "error",
      message: "Those terms are out of date. Reload and try again.",
    });
    await renderOnboarding();
    fireEvent.click(screen.getByLabelText("Agree and continue"));

    expect(await screen.findByText(/terms are out of date/i)).toBeTruthy();
    expect(fake.replace).not.toHaveBeenCalled();
  });

  it("keeps new accounts on name and photo confirmation", async () => {
    fake.session = {
      ...establishedSession(),
      state: {
        status: "signed-in",
        user: { id: "u1", name: "Sam", email: "sam@example.com", image: null },
        needsOnboarding: true,
        needsTermsAcceptance: false,
      },
    };
    await renderOnboarding();

    expect(screen.getByLabelText("Display name")).toBeTruthy();
    expect(screen.queryByText(/terms have changed/i)).toBeNull();
  });
});
