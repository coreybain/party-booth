/**
 * The three flows App Review will look for, exercised end to end against a
 * mocked API.
 *
 * These are **Guideline 1.2** (report content, block users) and **5.1.1(v)**
 * (in-app account deletion) requirements, not features. A build missing any of
 * them is rejected, and a rejection costs a review cycle we do not have before
 * 5 August — so they get tests that fail loudly rather than a manual check
 * somebody does once.
 *
 * What each one is actually asserting is the *promise the copy makes*, not just
 * that a mutation fired:
 *
 * - reporting says the host decides and that nothing is hidden by it, because
 *   the backend flags rather than moderates and a guest who expected the photo
 *   to vanish would report it again and again;
 * - blocking says it is silent and does not eject, because `blocks.block`
 *   touches no membership;
 * - deletion says access goes now, everything is erased in thirty days, and
 *   photographs are anonymised in the meantime — the last of which is the part a
 *   guest is most likely to be surprised by. "Erased" is load-bearing: the purge
 *   worker (`convex/deletion.ts`) ships with the button, so the copy is a
 *   description rather than an intention.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REPORT_REASONS } from "@partybooth/contracts/media";

import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const fake = vi.hoisted(() => ({
  report: vi.fn(),
  block: vi.fn(),
  unblock: vi.fn(),
  requestAccountDeletion: vi.fn(),
  myBlocks: [] as unknown,
  signOut: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  session: {} as Record<string, unknown>,
  openBrowserAsync: vi.fn(),
  myEmails: [] as unknown[],
  requestVerification: vi.fn(),
  confirmVerification: vi.fn(),
}));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

vi.mock("expo-image", () => ({
  Image: () => createElement("img", { alt: "avatar" }),
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: fake.push, replace: fake.replace, back: vi.fn() }),
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: (...args: unknown[]) => fake.openBrowserAsync(...args),
}));

vi.mock("convex/react", () => ({
  useQuery: (reference: { name: string }) => {
    if (reference.name === "myBlocks") return fake.myBlocks;
    if (reference.name === "myEmails") return fake.myEmails;
    return undefined;
  },
  useAction: (reference: { name: string }) =>
    reference.name === "requestVerification" ? fake.requestVerification : vi.fn(),
  useMutation: (reference: { name: string }) => {
    if (reference.name === "block") return fake.block;
    if (reference.name === "unblock") return fake.unblock;
    if (reference.name === "requestAccountDeletion") return fake.requestAccountDeletion;
    if (reference.name === "confirmVerification") return fake.confirmVerification;
    return fake.report;
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
      moderation: { report: { name: "report" } },
      push: {
        preferences: { name: "preferences" },
        updatePreferences: { name: "updatePreferences" },
      },
      blocks: {
        block: { name: "block" },
        unblock: { name: "unblock" },
        myBlocks: { name: "myBlocks" },
      },
    },
  };
});

vi.mock("@/env", () => ({
  appConfig: {
    status: "ready",
    siteUrl: "https://partybooth.example",
    features: { sentry: false, push: false },
  },
}));

vi.mock("@/providers/session", () => ({ useSession: () => fake.session }));
vi.mock("@/lib/sentry", () => ({
  captureHandledError: vi.fn(),
  isSentryEnabled: () => false,
}));

// Settings gained a notifications section in Sprint 5, so it now reaches the
// push provider — which reaches `expo-file-system` for the little bit of state
// that survives a restart, and that is a native module jsdom cannot import.
// Faked at the provider rather than at the filesystem, so nothing about the
// three App Review flows below depends on push behaviour. It has its own suite
// (`push-lifecycle.test.tsx`); `appConfig.features.push` is `false` above, so
// this screen renders the "no Expo project" line and nothing else.
vi.mock("@/push/provider", () => ({
  usePush: () => ({
    permission: "undetermined",
    step: "idle",
    registered: false,
    armPrompt: vi.fn(),
    enableNotifications: vi.fn(),
  }),
}));

const A_TARGET = {
  mediaId: "media_1",
  uploaderUserId: "user_2",
  uploaderDisplayName: "Sam",
  isOwn: false,
};

beforeEach(() => {
  fake.report.mockResolvedValue({ reportId: "report_1", created: true, reportCount: 1 });
  fake.block.mockResolvedValue({ blocked: true, created: true });
  fake.unblock.mockResolvedValue({ blocked: false, removed: true });
  fake.requestAccountDeletion.mockResolvedValue({
    accountState: "deletionScheduled",
    scheduledAt: Date.now() + 30 * 86_400_000,
  });
  fake.signOut.mockResolvedValue(undefined);
  fake.myBlocks = [];
  fake.myEmails = [];
  fake.requestVerification.mockReset().mockResolvedValue(null);
  fake.confirmVerification.mockReset().mockResolvedValue({
    ok: true,
    organiserUnlocked: false,
    cohostEventIds: [],
  });
  fake.session = {
    state: {
      status: "signed-in",
      user: { id: "user_1", name: "Corey", email: "corey@example.com", image: null },
      needsOnboarding: false,
    },
    configured: true,
    signOut: fake.signOut,
    previewEventRole: null,
    setPreviewEventRole: vi.fn(),
    activeEvent: null,
    events: [],
  };
});

/* -------------------------------------------------------------------------- */
/* Settings: verified invitation addresses                                   */
/* -------------------------------------------------------------------------- */

describe("Settings — verified invitation addresses", () => {
  it("lists claimed addresses and their verification state", async () => {
    fake.myEmails = [
      { email: "host@example.com", status: "verified", verifiedAt: 1 },
      { email: "other@example.com", status: "pending" },
    ];
    await renderSettings();

    expect(screen.getByText("host@example.com")).toBeTruthy();
    expect(screen.getByText("other@example.com")).toBeTruthy();
    expect(screen.getByText("VERIFIED")).toBeTruthy();
    expect(screen.getByText("PENDING")).toBeTruthy();
  });

  it("requests and confirms a code, then says which roles were unlocked", async () => {
    fake.confirmVerification.mockResolvedValue({
      ok: true,
      organiserUnlocked: true,
      cohostEventIds: ["event_1"],
    });
    await renderSettings();

    fireEvent.change(screen.getByLabelText("Address to verify"), {
      target: { value: " Invited@Example.com " },
    });
    fireEvent.click(screen.getByLabelText("Send verification code"));

    await waitFor(() => {
      expect(fake.requestVerification).toHaveBeenCalledWith({ email: "invited@example.com" });
    });
    fireEvent.change(screen.getByLabelText("Six-digit verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByLabelText("Verify email"));

    await waitFor(() => {
      expect(fake.confirmVerification).toHaveBeenCalledWith({
        email: "invited@example.com",
        code: "123456",
      });
      expect(screen.getByText(/unlocked organiser access and 1 co-host role/i)).toBeTruthy();
    });
  });

  it("shows committed wrong-code failures instead of claiming success", async () => {
    fake.confirmVerification.mockResolvedValue({
      ok: false,
      reason: "invalid",
      message: "That code is not valid, or it has expired. Ask for a new one.",
    });
    await renderSettings();

    fireEvent.change(screen.getByLabelText("Address to verify"), {
      target: { value: "invited@example.com" },
    });
    fireEvent.click(screen.getByLabelText("Send verification code"));
    await screen.findByLabelText("Six-digit verification code");
    fireEvent.change(screen.getByLabelText("Six-digit verification code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByLabelText("Verify email"));

    expect(await screen.findByText(/code is not valid/i)).toBeTruthy();
    expect(screen.queryByText(/This unlocked/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

async function renderReportSheet(onBlock: ((userId: string) => Promise<void>) | null = vi.fn()) {
  const { ReportSheet } = await import("@/components/report-sheet");
  const onClose = vi.fn();
  const onReport = vi.fn(async (input: unknown) => {
    await fake.report(input);
  });
  render(createElement(ReportSheet, { target: A_TARGET, onReport, onBlock, onClose }));
  return { onReport, onClose };
}

describe("report content — Guideline 1.2", () => {
  it("offers every reason the contract defines", async () => {
    // Driven off `REPORT_REASONS` rather than a literal list, so adding a reason
    // to the contract fails here rather than silently going unoffered.
    await renderReportSheet();
    expect(screen.getAllByRole("radio")).toHaveLength(REPORT_REASONS.length);
  });

  it("will not send until a reason has been chosen", async () => {
    await renderReportSheet();
    expect(screen.getByLabelText("Send report").getAttribute("aria-disabled")).toBe("true");
  });

  it("says the host decides, and that reporting hides nothing by itself", async () => {
    // The backend flags rather than moderates: auto-hiding on report would hand
    // any guest a veto over any other guest's photograph. A guest who expected
    // it to vanish reports it again, and again.
    await renderReportSheet();
    expect(screen.getByText(/reviews it and decides/i)).toBeTruthy();
    expect(screen.getByText(/does not remove anything on its own/i)).toBeTruthy();
  });

  it("promises the reporter is not named, which is what Convex enforces", async () => {
    await renderReportSheet();
    expect(screen.getByText(/nobody is told who reported it/i)).toBeTruthy();
  });

  it("sends the chosen reason and confirms it", async () => {
    const { onReport } = await renderReportSheet();

    fireEvent.click(screen.getByLabelText("Nudity or sexual content"));
    fireEvent.click(screen.getByLabelText("Send report"));

    await waitFor(() => {
      expect(onReport).toHaveBeenCalledTimes(1);
    });
    expect(onReport.mock.calls[0]?.[0]).toEqual({
      mediaId: "media_1",
      reason: "nudityOrSexual",
    });
    await waitFor(() => {
      expect(screen.getByText(/the host has been told/i)).toBeTruthy();
    });
  });

  it("omits empty free text rather than sending a blank string", async () => {
    const { onReport } = await renderReportSheet();

    fireEvent.click(screen.getByLabelText("Something else"));
    fireEvent.change(screen.getByLabelText("Anything else the host should know"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByLabelText("Send report"));

    await waitFor(() => {
      expect(onReport).toHaveBeenCalled();
    });
    expect(onReport.mock.calls[0]?.[0]).not.toHaveProperty("details");
  });

  it("passes free text through when there is some", async () => {
    const { onReport } = await renderReportSheet();

    fireEvent.click(screen.getByLabelText("Something else"));
    fireEvent.change(screen.getByLabelText("Anything else the host should know"), {
      target: { value: "  I am in this and did not agree.  " },
    });
    fireEvent.click(screen.getByLabelText("Send report"));

    await waitFor(() => {
      expect(onReport).toHaveBeenCalled();
    });
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({
      details: "I am in this and did not agree.",
    });
  });

  it("shows a failure rather than pretending the report was filed", async () => {
    const { ReportSheet } = await import("@/components/report-sheet");
    render(
      createElement(ReportSheet, {
        target: A_TARGET,
        onReport: vi.fn().mockRejectedValue(new Error("offline")),
        onBlock: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByLabelText("Violence or gore"));
    fireEvent.click(screen.getByLabelText("Send report"));

    await waitFor(() => {
      expect(screen.getByText(/didn't send/i)).toBeTruthy();
    });
    expect(screen.queryByText(/the host has been told/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Blocking                                                                   */
/* -------------------------------------------------------------------------- */

describe("block a user — Guideline 1.2", () => {
  it("is offered straight after a report, where the thought occurs", async () => {
    const onBlock = vi.fn(async () => {});
    await renderReportSheet(onBlock);

    fireEvent.click(screen.getByLabelText("Hate or harassment"));
    fireEvent.click(screen.getByLabelText("Send report"));

    await waitFor(() => {
      expect(screen.getByLabelText("Block Sam")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Block Sam"));
    await waitFor(() => {
      expect(onBlock).toHaveBeenCalledWith("user_2");
    });
    expect(screen.getByText(/You've blocked Sam/)).toBeTruthy();
  });

  it("says blocking is silent and does not eject, which is what Convex does", async () => {
    const onBlock = vi.fn(async () => {});
    await renderReportSheet(onBlock);

    fireEvent.click(screen.getByLabelText("Something else"));
    fireEvent.click(screen.getByLabelText("Send report"));
    await waitFor(() => {
      expect(screen.getByLabelText("Block Sam")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("Block Sam"));

    await waitFor(() => {
      // `blocks.block` is a filter on your own reads. It touches no membership,
      // and nobody is told. Copy that implied otherwise would be a lie.
      expect(screen.getByText(/They are not told, and they stay in the party/i)).toBeTruthy();
    });
  });

  it("is also reachable without reporting anybody first", async () => {
    // App Review looks for blocking as its own control, and a guest who simply
    // does not want to see somebody's photographs has not filed a complaint.
    const { ItemActionsMenu } = await import("@/components/report-sheet");
    const onBlock = vi.fn();
    const onReport = vi.fn();
    render(
      createElement(ItemActionsMenu, {
        target: A_TARGET,
        onReport,
        onBlock,
        onClose: vi.fn(),
      }),
    );

    expect(screen.getByLabelText("Report to the host")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Block Sam"));
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onReport).not.toHaveBeenCalled();
  });

  it("never offers to block or report your own item", async () => {
    const { ReportSheet } = await import("@/components/report-sheet");
    render(
      createElement(ReportSheet, {
        target: { ...A_TARGET, isOwn: true },
        onReport: vi.fn(async () => {}),
        onBlock: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByLabelText("Something else"));
    fireEvent.click(screen.getByLabelText("Send report"));
    await waitFor(() => {
      expect(screen.getByText(/the host has been told/i)).toBeTruthy();
    });
    // Blocking yourself is nonsense; "Take it back" in My media is the control.
    expect(screen.queryByLabelText("Block Sam")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Settings: blocked list and deletion                                        */
/* -------------------------------------------------------------------------- */

async function renderSettings() {
  const { default: SettingsScreen } = await import("../../app/(tabs)/settings");
  return render(createElement(SettingsScreen));
}

describe("Settings — the blocked list", () => {
  it("explains what blocking does when nobody is blocked", async () => {
    await renderSettings();
    expect(screen.getByText(/have not blocked anyone/i)).toBeTruthy();
  });

  it("lists blocked accounts and unblocks them", async () => {
    fake.myBlocks = [{ userId: "user_2", displayName: "Sam", createdAt: 0 }];
    await renderSettings();

    expect(screen.getByText("Sam")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Unblock"));

    await waitFor(() => {
      expect(fake.unblock).toHaveBeenCalledWith({ userId: "user_2" });
    });
  });
});

describe("Settings — in-app account deletion (5.1.1(v))", () => {
  it("offers deletion without leaving the app", async () => {
    await renderSettings();
    expect(screen.getByLabelText("Delete my account")).toBeTruthy();
  });

  it("asks first, and the second step says what actually happens", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Delete my account"));

    // Access now, everything erased in thirty days, photographs anonymised in
    // the meantime. The last is the part a guest is most likely to be surprised
    // by, so it is said before the button rather than after — and the middle one
    // has to say *erased*, because it is what the purge worker now does.
    expect(screen.getByText(/signed out straight away/i)).toBeTruthy();
    expect(screen.getByText(/After 30 days everything goes/i)).toBeTruthy();
    expect(screen.getByText(/your name comes off them/i)).toBeTruthy();
    expect(fake.requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("points at withdrawal for somebody who wants the photographs gone", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Delete my account"));
    expect(screen.getByText(/take it back/i)).toBeTruthy();
  });

  it("schedules the deletion, signs out, and leaves the tabs", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Delete my account"));
    fireEvent.click(screen.getByLabelText("Yes, delete my account"));

    await waitFor(() => {
      expect(fake.requestAccountDeletion).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fake.signOut).toHaveBeenCalledTimes(1);
    });
    expect(fake.replace).toHaveBeenCalledWith("/");
  });

  it("does not sign out when the deletion could not be recorded", async () => {
    // The other order would leave a guest signed out with no idea whether the
    // deletion happened, and no session left to retry it with.
    fake.requestAccountDeletion.mockRejectedValue(new Error("offline"));
    await renderSettings();

    fireEvent.click(screen.getByLabelText("Delete my account"));
    fireEvent.click(screen.getByLabelText("Yes, delete my account"));

    await waitFor(() => {
      expect(fake.requestAccountDeletion).toHaveBeenCalled();
    });
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(fake.replace).not.toHaveBeenCalled();
  });

  it("lets a guest back out", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Delete my account"));
    fireEvent.click(screen.getByLabelText("Keep my account"));

    expect(screen.getByLabelText("Delete my account")).toBeTruthy();
    expect(fake.requestAccountDeletion).not.toHaveBeenCalled();
  });
});

describe("Settings — the privacy policy (5.1.1(i))", () => {
  it("opens the policy from the configured site", async () => {
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Privacy policy"));

    await waitFor(() => {
      expect(fake.openBrowserAsync).toHaveBeenCalledWith("https://partybooth.example/privacy");
    });
  });
});
