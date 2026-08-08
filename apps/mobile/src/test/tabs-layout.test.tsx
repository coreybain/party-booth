import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "@/lib/api";
import type { ReactNode } from "react";

const NOW = Date.UTC(2026, 7, 5, 20, 0, 0);

const fake = vi.hoisted(() => ({
  now: Date.UTC(2026, 7, 5, 20, 0, 0),
  session: {} as Record<string, unknown>,
}));

vi.mock("expo-router", () => {
  const Tabs = (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode);
  Tabs.Screen = (props: { name: string; options?: { href?: string | null } }) =>
    createElement("div", {
      "data-testid": `tab-${props.name}`,
      "data-href": props.options?.href === null ? "hidden" : (props.options?.href ?? "default"),
    });
  return {
    Tabs,
    Redirect: (props: { href: string }) =>
      createElement("div", { "data-testid": "redirect", "data-href": props.href }),
  };
});

vi.mock("@/hooks/use-now", () => ({ useNow: () => fake.now }));
vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => createElement("span") }));

function anEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "event_1",
    name: "Corey's 40th",
    state: "live",
    moderationMode: "manual",
    startsAt: NOW - 24 * 60 * 60 * 1000,
    endsAt: NOW - 1,
    timeZone: "Australia/Sydney",
    allowLibraryImport: true,
    publicGalleryEnabled: true,
    storageRegion: "pdx1",
    role: "guest",
    counts: { pending: 0, approved: 8, declined: 0, total: 8 },
    ...overrides,
    photoChallengesEnabled: overrides.photoChallengesEnabled ?? false,
  };
}

beforeEach(() => {
  fake.now = NOW;
  fake.session = {
    state: {
      status: "signed-in",
      user: {},
      needsOnboarding: false,
      needsTermsAcceptance: false,
    },
    roles: { accountRole: "member", eventRole: "guest", accountLocked: false },
    activeEvent: anEvent(),
  };
});

describe("TabsLayout", () => {
  it("hides Camera but keeps Photos available for a past event", async () => {
    const { default: TabsLayout } = await import("../../app/(tabs)/_layout");
    render(createElement(TabsLayout));

    expect(screen.getByTestId("tab-camera").getAttribute("data-href")).toBe("hidden");
    expect(screen.getByTestId("tab-photos").getAttribute("data-href")).toBe("default");
  });
});
