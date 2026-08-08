import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "@/lib/api";
import type { ReactNode } from "react";

const NOW = Date.UTC(2026, 7, 5, 20, 0, 0);

const fake = vi.hoisted(() => ({
  now: Date.UTC(2026, 7, 5, 20, 0, 0),
  leave: vi.fn(),
  push: vi.fn(),
  selectEvent: vi.fn(),
  session: {} as Record<string, unknown>,
}));

vi.mock("convex/react", () => ({ useMutation: () => fake.leave }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: fake.push }) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => fake.now }));
vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

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
  const event = anEvent();
  fake.session = {
    events: [event],
    activeEvent: event,
    eventsLoading: false,
    selectEvent: fake.selectEvent,
    configured: true,
  };
});

describe("PartiesScreen", () => {
  it("labels a live event whose scheduled end has passed as a past event", async () => {
    const { default: PartiesScreen } = await import("../../app/(tabs)/settings/parties");
    render(createElement(PartiesScreen));

    expect(screen.getByText("PAST EVENT")).toBeTruthy();
    expect(screen.queryByText("LIVE")).toBeNull();
  });
});
