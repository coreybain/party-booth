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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  challengeDeck: undefined as unknown,
  moderate: vi.fn(),
  rotate: vi.fn(),
  setState: vi.fn(),
  update: vi.fn(),
  resolveReport: vi.fn(),
  createChallenge: vi.fn(),
  updateChallenge: vi.fn(),
  setArchivedChallenge: vi.fn(),
  setChallengesEnabled: vi.fn(),
  queryCalls: [] as { readonly name: string; readonly args: unknown }[],
  session: {} as Record<string, unknown>,
  copyText: vi.fn(),
  copyImage: vi.fn(),
  shareImage: vi.fn(),
  captureView: vi.fn(),
}));

// Dispatched on the function reference, exactly as Convex does, so a screen that
// asked for the wrong query fails here rather than silently rendering the other
// list.
vi.mock("convex/react", () => ({
  useQuery: (reference: { name: string }, args: unknown) => {
    if (args === "skip") return undefined;
    fake.queryCalls.push({ name: reference.name, args });
    if (reference.name === "current") return fake.invite;
    if (reference.name === "flagged") return fake.flagged;
    if (reference.name === "photoChallenges.list") return fake.challengeDeck;
    return fake.pending;
  },
  useMutation: (reference: { name: string }) => {
    if (reference.name === "rotate") return fake.rotate;
    if (reference.name === "setState") return fake.setState;
    if (reference.name === "update") return fake.update;
    if (reference.name === "resolveReport") return fake.resolveReport;
    if (reference.name === "photoChallenges.create") return fake.createChallenge;
    if (reference.name === "photoChallenges.update") return fake.updateChallenge;
    if (reference.name === "photoChallenges.setArchived") return fake.setArchivedChallenge;
    if (reference.name === "photoChallenges.setEnabled") return fake.setChallengesEnabled;
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
        resolveReport: { name: "resolveReport" },
      },
      photo_challenges: {
        list: { name: "photoChallenges.list" },
        create: { name: "photoChallenges.create" },
        update: { name: "photoChallenges.update" },
        setArchived: { name: "photoChallenges.setArchived" },
        setEnabled: { name: "photoChallenges.setEnabled" },
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

vi.mock("expo-clipboard", () => ({
  setStringAsync: fake.copyText,
  setImageAsync: fake.copyImage,
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(true),
  shareAsync: fake.shareImage,
}));

vi.mock("react-native-view-shot", () => ({ captureRef: fake.captureView }));

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
    publicGalleryEnabled: false,
    storageRegion: "pdx1",
    role: "owner",
    counts: { pending: 2, approved: 8, declined: 1, total: 11 },
    ...overrides,
    photoChallengesEnabled: overrides.photoChallengesEnabled ?? false,
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
  fake.challengeDeck = {
    enabled: false,
    activeCount: 3,
    minimumActive: 3,
    maximumActive: 50,
    challenges: [
      {
        id: "challenge_1",
        prompt: "Recreate a movie poster",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "challenge_2",
        prompt: "Find the brightest colour",
        status: "active",
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "challenge_3",
        prompt: "Capture a tiny detail",
        status: "active",
        createdAt: 3,
        updatedAt: 3,
      },
    ],
  };
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
  fake.resolveReport.mockResolvedValue({ status: "actioned", stillFlagged: false });
  fake.createChallenge.mockResolvedValue(null);
  fake.updateChallenge.mockResolvedValue(null);
  fake.setArchivedChallenge.mockResolvedValue(null);
  fake.setChallengesEnabled.mockResolvedValue({ enabled: true });
  fake.copyText.mockResolvedValue(true);
  fake.copyImage.mockResolvedValue(undefined);
  fake.shareImage.mockResolvedValue(undefined);
  fake.captureView.mockImplementation((_view: unknown, options: { result?: string }) =>
    Promise.resolve(options.result === "base64" ? "QR_BASE64" : "file:///invite.png"),
  );
  fake.queryCalls.length = 0;
});

/* -------------------------------------------------------------------------- */
/* Role gating                                                                */
/* -------------------------------------------------------------------------- */

describe("who gets the host tools", () => {
  it("shows the schedule-aware past-event status to the host", async () => {
    fake.session = session({ eventRole: "owner" }, anEvent({ endsAt: 1 }));
    await renderHost();

    expect(screen.getByText("PAST EVENT")).toBeTruthy();
    expect(screen.queryByText("LIVE")).toBeNull();
  });

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
    expect(screen.getByText(/Temporarily stop uploads/i)).toBeTruthy();
    expect(screen.getByText(/Move the scheduled finish back/i)).toBeTruthy();
    expect(screen.getByText(/disable the join code/i)).toBeTruthy();
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

describe("photo challenges", () => {
  it("lets a host discover the deck and add a custom prompt", async () => {
    await renderHost();

    expect(screen.getByText("Photo challenges")).toBeTruthy();
    expect(screen.getByText("Recreate a movie poster")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Add a challenge"), {
      target: { value: "Photograph matching colours" },
    });
    fireEvent.click(screen.getByText("Add challenge"));

    await waitFor(() =>
      expect(fake.createChallenge).toHaveBeenCalledWith({
        eventId: "event_1",
        prompt: "Photograph matching colours",
      }),
    );
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

  it("offers focused copy choices and copies the requested invite value", async () => {
    await renderHost();

    fireEvent.click(screen.getByLabelText("Copy"));
    expect(screen.getByText("Copy join code")).toBeTruthy();
    expect(screen.getByText("Copy join link")).toBeTruthy();
    expect(screen.getByText("Copy QR image")).toBeTruthy();
    expect(screen.getByText("Copy all details")).toBeTruthy();

    fireEvent.click(screen.getByText("Copy join code"));
    await waitFor(() => expect(fake.copyText).toHaveBeenCalledWith("482913"));
    expect(screen.getByText("Join code copied.")).toBeTruthy();
  });

  it("copies the rendered QR as an image", async () => {
    await renderHost();

    fireEvent.click(screen.getByLabelText("Copy"));
    fireEvent.click(screen.getByText("Copy QR image"));

    await waitFor(() => expect(fake.copyImage).toHaveBeenCalledWith("QR_BASE64"));
    expect(fake.captureView).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "png", result: "base64" }),
    );
  });

  it("offers the code, link, QR image, and complete invite for sharing", async () => {
    await renderHost();

    fireEvent.click(screen.getByLabelText("Share"));
    expect(screen.getByText("Share join code")).toBeTruthy();
    expect(screen.getByText("Share join link")).toBeTruthy();
    expect(screen.getByText("Share QR image")).toBeTruthy();
    expect(screen.getByText("Share complete invite")).toBeTruthy();

    fireEvent.click(screen.getByText("Share complete invite"));
    await waitFor(() =>
      expect(fake.shareImage).toHaveBeenCalledWith(
        "file:///invite.png",
        expect.objectContaining({ mimeType: "image/png" }),
      ),
    );
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
  it("refreshes both short-lived host review subscriptions before their URLs expire", async () => {
    await renderHost();

    expect(fake.queryCalls).toContainEqual({
      name: "flagged",
      args: { eventId: "event_1", limit: 10, urlRefreshKey: expect.any(Number) },
    });
    expect(fake.queryCalls).toContainEqual({
      name: "pending",
      args: { eventId: "event_1", limit: 40, urlRefreshKey: expect.any(Number) },
    });
  });

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

  it("marks every open report handled sequentially", async () => {
    fake.flagged = [
      {
        media: aMedia({ id: "media_9", uploaderDisplayName: "Alex", reportCount: 2 }),
        reports: [
          { id: "r1", reason: "harassment", status: "open", createdAt: 2 },
          { id: "r2", reason: "other", status: "open", createdAt: 1 },
        ],
      },
    ];
    let releaseFirst: (() => void) | undefined;
    fake.resolveReport
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ status: "actioned", stillFlagged: true });
          }),
      )
      .mockResolvedValueOnce({ status: "actioned", stillFlagged: false });
    await renderHost();

    fireEvent.click(screen.getByLabelText("Mark handled"));

    expect(fake.resolveReport).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Dismiss").getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      releaseFirst?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fake.resolveReport).toHaveBeenCalledTimes(2);
    });
    expect(fake.resolveReport.mock.calls).toEqual([
      [{ reportId: "r1", status: "actioned" }],
      [{ reportId: "r2", status: "actioned" }],
    ]);
  });

  it("dismisses reports and restores the controls after a failure", async () => {
    fake.flagged = [
      {
        media: aMedia({ id: "media_9", uploaderDisplayName: "Alex", reportCount: 1 }),
        reports: [{ id: "r1", reason: "other", status: "open", createdAt: 1 }],
      },
    ];
    fake.resolveReport.mockRejectedValueOnce(new Error("offline"));
    await renderHost();

    fireEvent.click(screen.getByLabelText("Dismiss"));

    await waitFor(() => {
      expect(screen.getByText(/Some reports are still open/i)).toBeTruthy();
    });
    expect(fake.resolveReport).toHaveBeenCalledWith({ reportId: "r1", status: "dismissed" });
    expect(screen.getByLabelText("Mark handled").getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByLabelText("Dismiss").getAttribute("aria-disabled")).not.toBe("true");
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

    fireEvent.click(screen.getByText(/Add one hour/i));
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
    expect(screen.queryByText(/Add one hour/i)).toBeNull();
  });
});
