/**
 * The Host tab is the real thing now, and these are the assertions that would
 * have caught it if it were not.
 *
 * Sprint 3's expensive lesson was that "built and unit-tested" is not "mounted":
 * `use-capture` was green while being imported by nothing. This tab spent two
 * sprints rendering a card that said "sprint 5" next to a live `moderation.
 * pending` query nobody called, so the same class of defect is exactly what is
 * checked here — the queue is really queried, the code is really shown, the
 * rotation modal really reaches the mutation with the choice the host made, and
 * a guest who navigates here directly gets none of it.
 *
 * Convex, the session and the image component are faked. The screen, the QR
 * renderer, `hostAbilities` and the layout primitives are real.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSummary, MediaItem } from "@/lib/api";
import type { RoleContext } from "@/lib/roles";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const fake = vi.hoisted(() => ({
  invite: undefined as unknown,
  pending: undefined as unknown,
  flagged: undefined as unknown,
  moderate: vi.fn(),
  rotate: vi.fn(),
  setState: vi.fn(),
  update: vi.fn(),
  session: {} as Record<string, unknown>,
}));

// Dispatched on the function reference, exactly as Convex does, so a screen that
// asked for the wrong query fails here rather than silently rendering the other
// list.
vi.mock("convex/react", () => ({
  useQuery: (reference: { name: string }, args: unknown) => {
    if (args === "skip") return undefined;
    if (reference.name === "current") return fake.invite;
    if (reference.name === "flagged") return fake.flagged;
    return fake.pending;
  },
  useMutation: (reference: { name: string }) => {
    if (reference.name === "rotate") return fake.rotate;
    if (reference.name === "setState") return fake.setState;
    if (reference.name === "update") return fake.update;
    return fake.moderate;
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    api: {
      events: { setState: { name: "setState" }, update: { name: "update" } },
      invites: { current: { name: "current" }, rotate: { name: "rotate" } },
      moderation: {
        pending: { name: "pending" },
        flagged: { name: "flagged" },
        moderate: { name: "moderate" },
      },
    },
  };
});

vi.mock("@/env", () => ({
  appConfig: { status: "ready", siteUrl: "https://partybooth.app", features: { push: true } },
}));

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) =>
    createElement("img", { alt: String(props.accessibilityLabel ?? "thumbnail") }),
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
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function anEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "event_1",
    name: "Sam's 30th",
    state: "live",
    moderationMode: "manual",
    startsAt: Date.UTC(2026, 7, 5, 19, 0, 0),
    endsAt: Date.UTC(2026, 7, 6, 1, 0, 0),
    timeZone: "Europe/London",
    allowLibraryImport: true,
    storageRegion: "pdx1",
    role: "owner",
    counts: { pending: 2, approved: 8, declined: 1, total: 11 },
    ...overrides,
  };
}

function aMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media_1",
    eventId: "event_1",
    captureId: "cap_1",
    state: "pending",
    mediaType: "photo",
    fromLibrary: false,
    byteSize: 2_048,
    mimeType: "image/jpeg",
    uploaderUserId: "user_2",
    uploaderDisplayName: "Priya",
    isOwn: false,
    createdAt: Date.UTC(2026, 7, 5, 20, 0, 0),
    ...overrides,
  };
}

function session(roles: Partial<RoleContext>, event: EventSummary | null = anEvent()) {
  return {
    roles: { accountRole: "member", eventRole: null, accountLocked: false, ...roles },
    activeEvent: event,
    configured: true,
    eventsLoading: false,
  };
}

async function renderHost() {
  const { default: HostScreen } = await import("../../app/(tabs)/host");
  render(createElement(HostScreen));
}

beforeEach(() => {
  fake.invite = {
    inviteVersionId: "iv1",
    version: 3,
    code: "482913",
    token: "TOKEN123",
    createdAt: 0,
  };
  fake.pending = [aMedia()];
  fake.flagged = [];
  fake.session = session({ eventRole: "owner" });
  fake.moderate.mockResolvedValue({ changed: 1, unchanged: 0, refused: [], results: [] });
  fake.rotate.mockResolvedValue({
    inviteVersionId: "iv2",
    version: 4,
    code: "771204",
    token: "TOKEN456",
    revokedMemberships: 0,
  });
  fake.setState.mockResolvedValue({ state: "paused" });
  fake.update.mockResolvedValue(null);
});

/* -------------------------------------------------------------------------- */
/* Role gating                                                                */
/* -------------------------------------------------------------------------- */

describe("who gets the host tools", () => {
  it("shows a guest nothing but an explanation", async () => {
    // `href: null` in the tab layout removes the *button*. The route stays
    // reachable by `router.push` and by a notification tap, so the screen has to
    // defend itself — treating navigation as the gate is how host tools leak.
    fake.session = session({ eventRole: "guest" });
    await renderHost();

    expect(screen.getByText(/Host tools aren't available/i)).toBeTruthy();
    expect(screen.queryByText(/482 913/)).toBeNull();
    expect(screen.queryByText(/Waiting for you/i)).toBeNull();
  });

  it("shows a co-host the queue and the code but not the way to end the party", async () => {
    fake.session = session({ eventRole: "cohost" });
    await renderHost();

    expect(screen.getByText("482 913")).toBeTruthy();
    expect(screen.getByText(/Pause new photos/i)).toBeTruthy();
    expect(screen.getByText(/Rotate the code/i)).toBeTruthy();
    // PLAN.md's line: a co-host operates the party, the owner ends it.
    expect(screen.queryByText(/End the party/i)).toBeNull();
  });

  it("shows an owner the full set", async () => {
    await renderHost();
    expect(screen.getByText(/End the party/i)).toBeTruthy();
  });

  it("suspends every control when the account is locked", async () => {
    // The RC5 demo from the phone's side. Convex refuses regardless; a screen
    // full of live-looking buttons that all throw is the worse failure.
    fake.session = session({ eventRole: "owner", accountLocked: true });
    await renderHost();

    expect(screen.getByText(/Your account is locked/i)).toBeTruthy();
    expect(screen.queryByText(/Pause new photos/i)).toBeNull();
    expect(screen.queryByText(/Rotate the code/i)).toBeNull();
    // …and it does not tell them to ask themselves to be made a co-host.
    expect(screen.queryByText(/ask the host to add you/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The invite                                                                 */
/* -------------------------------------------------------------------------- */

describe("the invite", () => {
  it("renders the code spaced for reading aloud, and a QR of the join URL", async () => {
    await renderHost();

    expect(screen.getByText("482 913")).toBeTruthy();
    // The QR is a picture whose label is deliberately *not* the URL: the token
    // is a credential and a screen reader would announce it across the room.
    const qr = screen.getByLabelText(/QR code to join Sam's 30th/i);
    expect(qr).toBeTruthy();
    expect(qr.textContent).not.toContain("TOKEN123");
  });

  it("says so rather than breaking when there is no live invite", async () => {
    fake.invite = null;
    await renderHost();
    expect(screen.getByText(/no live invite/i)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* -------------------------------------------------------------------------- */

describe("the rotation modal", () => {
  it("keeps everybody in by default", async () => {
    await renderHost();
    fireEvent.click(screen.getByText(/Rotate the code/i));

    // The default is the overwhelmingly common case: the printed sign walked
    // off, and the people already inside did nothing wrong.
    fireEvent.click(screen.getByLabelText(/Rotate and keep everyone/i));
    await waitFor(() => {
      expect(fake.rotate).toHaveBeenCalledWith({
        eventId: "event_1",
        keepExistingMemberships: true,
      });
    });
  });

  it("sweeps the guest list only when the host says so", async () => {
    await renderHost();
    fireEvent.click(screen.getByText(/Rotate the code/i));

    fireEvent.click(screen.getByLabelText(/Also remove everyone already in/i));
    fireEvent.click(screen.getByText(/Rotate and remove guests/i));

    await waitFor(() => {
      expect(fake.rotate).toHaveBeenCalledWith({
        eventId: "event_1",
        keepExistingMemberships: false,
      });
    });
  });

  it("shows the new code rather than closing on top of it", async () => {
    fake.rotate.mockResolvedValue({
      inviteVersionId: "iv2",
      version: 4,
      code: "771204",
      token: "TOKEN456",
      revokedMemberships: 3,
    });
    await renderHost();

    fireEvent.click(screen.getByText(/Rotate the code/i));
    fireEvent.click(screen.getByLabelText(/Rotate and keep everyone/i));

    await waitFor(() => {
      expect(screen.getByText("771 204")).toBeTruthy();
    });
    // And it says what the sweep cost, in people rather than in ids.
    expect(screen.getByText(/3 guests were removed/i)).toBeTruthy();
  });

  it("reports a refusal instead of pretending it rotated", async () => {
    // A rotation budget refusal, a dropped connection, a locked account — the
    // modal stays open and says so. Silently doing nothing would leave a host
    // holding a sign whose code they believe is dead. (The wording comes from
    // `describeError`, which never surfaces a raw `Error.message`.)
    fake.rotate.mockRejectedValue(new Error("Rotations are limited to five an hour."));
    await renderHost();

    fireEvent.click(screen.getByText(/Rotate the code/i));
    fireEvent.click(screen.getByLabelText(/Rotate and keep everyone/i));

    await waitFor(() => {
      expect(screen.getByText(/That didn't work/i)).toBeTruthy();
    });
    expect(screen.queryByText("771 204")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The queue                                                                  */
/* -------------------------------------------------------------------------- */

describe("the pending queue", () => {
  it("lists what is waiting and approves one with a single tap", async () => {
    await renderHost();

    expect(screen.getByText("Priya")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Approve Priya's photo/i));

    await waitFor(() => {
      expect(fake.moderate).toHaveBeenCalledWith({
        eventId: "event_1",
        mediaIds: ["media_1"],
        action: "approve",
      });
    });
  });

  it("declines with the other one", async () => {
    await renderHost();
    fireEvent.click(screen.getByLabelText(/Decline Priya's photo/i));

    await waitFor(() => {
      expect(fake.moderate).toHaveBeenCalledWith({
        eventId: "event_1",
        mediaIds: ["media_1"],
        action: "decline",
      });
    });
  });

  it("reports a partial refusal verbatim rather than swallowing it", async () => {
    // The item moved under us — another host dealt with it, or the submitter
    // withdrew it. Nothing here is optimistic, so the row says so.
    fake.moderate.mockResolvedValue({
      changed: 0,
      unchanged: 0,
      refused: [
        { mediaId: "media_1", reason: "notPending", message: "Somebody already added it." },
      ],
      results: [],
    });
    await renderHost();

    fireEvent.click(screen.getByLabelText(/Approve Priya's photo/i));
    await waitFor(() => {
      expect(screen.getByText(/Somebody already added it/i)).toBeTruthy();
    });
  });

  it("offers one call for the whole queue, because parties arrive in bursts", async () => {
    fake.pending = [aMedia(), aMedia({ id: "media_2", captureId: "cap_2" })];
    await renderHost();

    fireEvent.click(screen.getByText(/Approve everything \(2\)/i));
    await waitFor(() => {
      expect(fake.moderate).toHaveBeenCalledWith({
        eventId: "event_1",
        mediaIds: ["media_1", "media_2"],
        action: "approve",
      });
    });
  });

  it("says nothing is waiting rather than showing an empty list", async () => {
    fake.pending = [];
    await renderHost();
    expect(screen.getByText(/Nothing waiting/i)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Reported items                                                             */
/* -------------------------------------------------------------------------- */

describe("flagged items", () => {
  it("surfaces them above the queue with the reason attached", async () => {
    fake.flagged = [
      {
        media: aMedia({ id: "media_9", uploaderDisplayName: "Alex", reportCount: 2 }),
        reports: [{ id: "r1", reason: "harassment", status: "open", createdAt: 0 }],
      },
    ];
    await renderHost();

    expect(screen.getByText(/Reported \(1\)/i)).toBeTruthy();
    expect(screen.getByText("Alex")).toBeTruthy();
    // A report flags; it never moderates. The host still decides.
    expect(screen.getByText(/it does not hide anything/i)).toBeTruthy();
  });

  it("renders nothing at all when nobody has reported anything", async () => {
    await renderHost();
    expect(screen.queryByText(/Reported \(/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Party controls                                                             */
/* -------------------------------------------------------------------------- */

describe("running the party", () => {
  it("pauses a live party", async () => {
    await renderHost();
    fireEvent.click(screen.getByText(/Pause new photos/i));

    await waitFor(() => {
      expect(fake.setState).toHaveBeenCalledWith({ eventId: "event_1", state: "paused" });
    });
  });

  it("opens a scheduled one early", async () => {
    fake.session = session({ eventRole: "owner" }, anEvent({ state: "scheduled" }));
    await renderHost();

    fireEvent.click(screen.getByText(/Open the party now/i));
    await waitFor(() => {
      expect(fake.setState).toHaveBeenCalledWith({ eventId: "event_1", state: "live" });
    });
  });

  it("pushes the finish time out by an hour without ending anything", async () => {
    const event = anEvent();
    await renderHost();

    fireEvent.click(screen.getByText(/Give it another hour/i));
    await waitFor(() => {
      expect(fake.update).toHaveBeenCalledWith({
        eventId: "event_1",
        schedule: {
          startsAt: event.startsAt,
          endsAt: (event.endsAt ?? 0) + 60 * 60_000,
          timeZone: "Europe/London",
        },
      });
    });
  });

  it("asks before ending the party", async () => {
    await renderHost();

    fireEvent.click(screen.getByText(/End the party/i));
    expect(fake.setState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Yes, end it/i));
    await waitFor(() => {
      expect(fake.setState).toHaveBeenCalledWith({ eventId: "event_1", state: "archived" });
    });
  });

  it("does not offer to extend a party with no finish time", async () => {
    fake.session = session({ eventRole: "owner" }, anEvent({ endsAt: undefined }));
    await renderHost();
    expect(screen.queryByText(/Give it another hour/i)).toBeNull();
  });
});
