/**
 * The push lifecycle, end to end, with the OS faked and nothing else.
 *
 * The four things that can go wrong here are all invisible until they happen on
 * somebody's phone, and two of them are unrecoverable:
 *
 * 1. **Prompting at launch.** iOS gives an app one prompt per install. Getting
 *    this wrong costs a refusal that the app can never revisit.
 * 2. **Never prompting.** A guest who joins and is never asked simply gets no
 *    notifications, and nothing anywhere says so.
 * 3. **Not registering an already-granted token.** Tokens rotate; a stale row is
 *    a notification delivered to nobody.
 * 4. **Not unregistering on sign-out.** A phone handed to a friend keeps buzzing
 *    with the previous account's party.
 *
 * `PushProvider` takes its adapter and its backend as props for exactly this —
 * the same shape `UploadQueueProvider` uses. The provider, the registration
 * rules and the routing table under test are the real ones.
 */

import { render, waitFor } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeNotificationsAdapter } from "@/push/adapter";
import { detachPushDevice } from "@/push/detach";
import { PushProvider, usePush, type PushBackend } from "@/push/provider";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  navigate: vi.fn(),
  selectEvent: vi.fn(),
  registerDevice: vi.fn(),
  unregisterDevice: vi.fn(),
  signedIn: true,
}));

// The provider only ever calls `Platform.OS`; the jsdom bundle reports "web",
// which `currentPlatform` correctly refuses to register. Pinning it to a phone
// is the difference between testing the lifecycle and testing that guard.
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Platform: { OS: "ios", select: (choices: Record<string, unknown>) => choices.ios },
  };
});

vi.mock("expo-router", () => ({ useRouter: () => ({ navigate: fake.navigate }) }));

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
}));

vi.mock("@/providers/session", () => ({
  useSession: () => ({
    state: fake.signedIn
      ? { status: "signed-in", user: {}, needsOnboarding: false }
      : { status: "signed-out" },
    selectEvent: fake.selectEvent,
  }),
}));

// The one bit of filesystem push owns. In memory, so "does a join survive a
// force-quit?" is a real question this suite can ask.
vi.mock("@/upload/device-store", () => ({
  readStoreFile: async (name: string) => fake.files.get(name) ?? null,
  writeStoreFile: async (name: string, contents: string) => {
    fake.files.set(name, contents);
  },
}));

vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const backend: PushBackend = {
  registerDevice: (args) => fake.registerDevice(args) as Promise<unknown>,
  unregisterDevice: (args) => fake.unregisterDevice(args) as Promise<unknown>,
};

/** Calls `armPrompt()` on mount — what `useJoinEvent` does after a join lands. */
function ArmOnMount() {
  const { armPrompt } = usePush();
  useEffect(() => armPrompt(), [armPrompt]);
  return null;
}

function mount(
  adapter: ReturnType<typeof createFakeNotificationsAdapter>,
  options: { projectId?: string | null; children?: ReactNode } = {},
) {
  return render(
    createElement(PushProvider, {
      backend,
      projectId: options.projectId === undefined ? "eas-project-id" : options.projectId,
      adapter,
      children: options.children ?? null,
    }),
  );
}

beforeEach(() => {
  fake.files.clear();
  fake.signedIn = true;
  fake.navigate.mockReset();
  fake.selectEvent.mockReset().mockResolvedValue({ status: "ok" });
  fake.registerDevice.mockReset().mockResolvedValue({ deviceId: "d1", created: true });
  fake.unregisterDevice.mockReset().mockResolvedValue({ removed: 1 });
});

/* -------------------------------------------------------------------------- */
/* Asking                                                                     */
/* -------------------------------------------------------------------------- */

describe("the permission prompt", () => {
  it("is not shown at app launch", async () => {
    const adapter = createFakeNotificationsAdapter();
    mount(adapter);

    // Configuration happens (the handler and the Android channel must exist
    // before anything can arrive) but nothing asks the guest anything.
    await waitFor(() => {
      expect(adapter.calls.configure).toBe(1);
    });
    expect(adapter.calls.requestPermission).toBe(0);
    expect(fake.registerDevice).not.toHaveBeenCalled();
  });

  it("is shown after a join, and then registers the token", async () => {
    const adapter = createFakeNotificationsAdapter();
    mount(adapter, { children: createElement(ArmOnMount) });

    await waitFor(() => {
      expect(adapter.calls.requestPermission).toBe(1);
    });
    await waitFor(() => {
      expect(fake.registerDevice).toHaveBeenCalledWith({
        expoPushToken: "ExponentPushToken[fake-device-token]",
        platform: "ios",
      });
    });
  });

  it("is not shown twice, even across a relaunch", async () => {
    const adapter = createFakeNotificationsAdapter();
    const first = mount(adapter, { children: createElement(ArmOnMount) });
    await waitFor(() => {
      expect(adapter.calls.requestPermission).toBe(1);
    });
    first.unmount();

    // Relaunch: the file survives, the permission the guest gave does not need
    // asking again, and a refusal must not be re-litigated on every cold start.
    const relaunch = createFakeNotificationsAdapter({ permission: "denied", canAskAgain: false });
    mount(relaunch, { children: createElement(ArmOnMount) });

    await waitFor(() => {
      expect(relaunch.calls.configure).toBe(1);
    });
    expect(relaunch.calls.requestPermission).toBe(0);
  });

  it("registers an already-granted token without asking anything", async () => {
    // Somebody who said yes last week. The token rotates under the app, so this
    // has to happen on every launch or their notifications quietly stop.
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);

    await waitFor(() => {
      expect(fake.registerDevice).toHaveBeenCalledTimes(1);
    });
    expect(adapter.calls.requestPermission).toBe(0);
  });

  it("does nothing at all while signed out", async () => {
    fake.signedIn = false;
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);

    await waitFor(() => {
      expect(adapter.calls.configure).toBe(1);
    });
    expect(fake.registerDevice).not.toHaveBeenCalled();
  });

  it("does nothing at all without an EAS project", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter, { projectId: null, children: createElement(ArmOnMount) });

    // Not even `configure`: a build with no project id never touches
    // expo-notifications, which is what keeps an empty-environment export inert.
    await Promise.resolve();
    expect(adapter.calls.configure).toBe(0);
    expect(fake.registerDevice).not.toHaveBeenCalled();
  });

  it("shrugs off a simulator that cannot mint a token", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    adapter.nextToken = null;
    mount(adapter);

    await waitFor(() => {
      expect(adapter.calls.getToken).toBe(1);
    });
    expect(fake.registerDevice).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Signing out                                                                */
/* -------------------------------------------------------------------------- */

describe("signing out", () => {
  it("gives the token up before the session goes", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);
    await waitFor(() => {
      expect(fake.registerDevice).toHaveBeenCalled();
    });

    // What `session.signOut` awaits. The row is deleted rather than disabled, so
    // whoever signs in on this phone next does not inherit these notifications.
    await detachPushDevice();
    expect(fake.unregisterDevice).toHaveBeenCalledWith({
      expoPushToken: "ExponentPushToken[fake-device-token]",
    });
  });

  it("never blocks a sign-out when the mutation fails", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);
    await waitFor(() => {
      expect(fake.registerDevice).toHaveBeenCalled();
    });

    fake.unregisterDevice.mockRejectedValue(new Error("offline"));
    // Being unable to sign out is far worse than a stale device row, which goes
    // quiet by itself on the next `DeviceNotRegistered`.
    await expect(detachPushDevice()).resolves.toBeUndefined();
  });

  it("does nothing when no provider is mounted", async () => {
    await expect(detachPushDevice()).resolves.toBeUndefined();
    expect(fake.unregisterDevice).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Taps                                                                       */
/* -------------------------------------------------------------------------- */

describe("tapping a notification", () => {
  it("switches to the party it names before it navigates", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);
    await waitFor(() => {
      expect(adapter.calls.configure).toBe(1);
    });

    adapter.emitResponse({ kind: "hostPendingThreshold", eventId: "event_9" });

    await waitFor(() => {
      expect(fake.navigate).toHaveBeenCalledWith("/host");
    });
    // A host with two parties told that *one* has a queue must land on that one.
    expect(fake.selectEvent).toHaveBeenCalledWith("event_9");
    expect(fake.selectEvent.mock.invocationCallOrder[0]).toBeLessThan(
      fake.navigate.mock.invocationCallOrder[0] as number,
    );
  });

  it("sends an upload failure to My media and an opening to the camera", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);
    await waitFor(() => {
      expect(adapter.calls.configure).toBe(1);
    });

    adapter.emitResponse({
      kind: "uploadStatus",
      transition: "failed",
      eventId: "e",
      captureId: "c",
    });
    await waitFor(() => {
      expect(fake.navigate).toHaveBeenCalledWith("/photos");
    });

    adapter.emitResponse({ kind: "eventLifecycle", transition: "opened", eventId: "e" });
    await waitFor(() => {
      expect(fake.navigate).toHaveBeenCalledWith("/camera");
    });
  });

  it("ignores a payload it does not recognise rather than navigating anywhere", async () => {
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    mount(adapter);
    await waitFor(() => {
      expect(adapter.calls.configure).toBe(1);
    });

    adapter.emitResponse({ kind: "somethingFromANewerServer" });
    await Promise.resolve();
    expect(fake.navigate).not.toHaveBeenCalled();
  });

  it("handles the tap that launched the app from cold", async () => {
    // `addNotificationResponseReceivedListener` does not replay it, so without
    // this a notification tapped from a killed app opens on whatever screen the
    // shell happens to restore.
    const adapter = createFakeNotificationsAdapter({ permission: "granted", canAskAgain: false });
    adapter.lastResponse = { data: { kind: "hostPendingThreshold", eventId: "event_1" } };
    mount(adapter);

    await waitFor(() => {
      expect(fake.navigate).toHaveBeenCalledWith("/host");
    });
  });
});
