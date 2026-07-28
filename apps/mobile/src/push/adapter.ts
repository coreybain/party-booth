/**
 * Everything `expo-notifications` does, behind one interface.
 *
 * Two reasons it is an adapter rather than direct calls, and they are the same
 * two reasons the backend put the Expo *send* API behind one:
 *
 * 1. **Tests run offline, with no device.** Notifications are a native module
 *    with a JSI bridge; under jsdom, importing it throws before any assertion
 *    can run. The registration lifecycle — prompt after a join, register on
 *    sign-in, unregister on sign-out, route on tap — is real behaviour with real
 *    bugs, and it is tested against {@link createFakeNotificationsAdapter}.
 * 2. **An empty environment must still export.** `expo export` bundles this
 *    module either way, so the native import is **dynamic**: nothing is
 *    evaluated until something actually asks for a token. A checkout with no EAS
 *    project id never calls a single Expo notifications function.
 *
 * The API surface below was checked against the current docs on 28 Jul 2026
 * (<https://docs.expo.dev/push-notifications/push-notifications-setup/> and the
 * `expo-notifications` SDK reference), because the two pieces that changed most
 * recently are exactly the two used here: the handler now returns
 * `shouldShowBanner`/`shouldShowList` rather than the deprecated
 * `shouldShowAlert`, and `getExpoPushTokenAsync` wants an explicit `projectId`
 * rather than inferring one.
 */

import type * as ExpoNotifications from "expo-notifications";

import type { PushPermission, PushPermissionSnapshot } from "./registration";

/** A tapped notification, reduced to the only part the app acts on. */
export interface PushResponse {
  readonly data: unknown;
}

export interface PushNotificationsAdapter {
  /**
   * Foreground presentation and the Android channel.
   *
   * Called once, before anything else. Foreground notifications are shown
   * deliberately: a guest with the app open on the Camera tab is exactly who
   * needs to be told their upload failed, and Expo's default is to swallow it.
   */
  configure: () => Promise<void>;
  getPermission: () => Promise<PushPermissionSnapshot>;
  /** Shows the system prompt. Exactly once per install on iOS — see `registration.ts`. */
  requestPermission: () => Promise<PushPermissionSnapshot>;
  /** `null` when the token cannot be minted: a simulator, or Expo unreachable. */
  getToken: (projectId: string) => Promise<string | null>;
  /** The tap that launched the app from cold, if there was one. */
  getLastResponse: () => Promise<PushResponse | null>;
  /** Taps while the app is running. Returns its own unsubscribe. */
  addResponseListener: (listener: (response: PushResponse) => void) => () => void;
  /** iOS app-icon badge. Cleared when the app is opened; harmless on Android. */
  clearBadge: () => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The real one                                                               */
/* -------------------------------------------------------------------------- */

type NotificationsModule = typeof ExpoNotifications;

let modulePromise: Promise<NotificationsModule> | null = null;

/**
 * Load `expo-notifications` on demand, once.
 *
 * Dynamic so that a bundle with no push configuration never evaluates it — the
 * same shape Settings uses for `expo-web-browser`. Memoised because the second
 * caller must get the same module instance, or a listener would be added to one
 * copy and removed from another.
 */
async function loadNotifications(): Promise<NotificationsModule> {
  modulePromise ??= import("expo-notifications");
  return await modulePromise;
}

function toSnapshot(permissions: { status: string; canAskAgain: boolean }): PushPermissionSnapshot {
  const permission: PushPermission =
    permissions.status === "granted"
      ? "granted"
      : permissions.status === "denied"
        ? "denied"
        : "undetermined";
  return { permission, canAskAgain: permissions.canAskAgain };
}

export function createExpoNotificationsAdapter(): PushNotificationsAdapter {
  return {
    configure: async () => {
      const Notifications = await loadNotifications();

      Notifications.setNotificationHandler({
        // `shouldShowBanner` / `shouldShowList` replaced `shouldShowAlert`; the
        // old key is accepted and deprecated, and using it means a notification
        // that arrives while the app is open is silently not drawn on iOS.
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
        }),
      });

      const { Platform } = await import("react-native");
      if (Platform.OS === "android") {
        // Android 8+ ignores per-notification importance; the channel is what
        // decides whether a ping makes a sound. Created before any notification
        // can arrive, because a channel cannot be upgraded after the fact.
        await Notifications.setNotificationChannelAsync("default", {
          name: "Party updates",
          importance: Notifications.AndroidImportance.DEFAULT,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: "#FF2E88",
        });
      }
    },

    getPermission: async () => {
      const Notifications = await loadNotifications();
      return toSnapshot(await Notifications.getPermissionsAsync());
    },

    requestPermission: async () => {
      const Notifications = await loadNotifications();
      return toSnapshot(await Notifications.requestPermissionsAsync());
    },

    getToken: async (projectId) => {
      const Device = await import("expo-device");
      // Simulators and emulators cannot receive a push, and asking anyway throws
      // — which would otherwise be the first thing every developer sees.
      if (!Device.isDevice) return null;

      const Notifications = await loadNotifications();
      try {
        const token = await Notifications.getExpoPushTokenAsync({ projectId });
        return token.data;
      } catch {
        // Offline, or an EAS project this build is not entitled to. Neither is
        // worth a red screen: notifications are the least important thing on a
        // phone at a party, and the next launch tries again.
        return null;
      }
    },

    getLastResponse: async () => {
      const Notifications = await loadNotifications();
      const response = await Notifications.getLastNotificationResponseAsync();
      if (response === null) return null;
      return { data: response.notification.request.content.data };
    },

    addResponseListener: (listener) => {
      let subscription: { remove: () => void } | null = null;
      let cancelled = false;

      void loadNotifications().then((Notifications) => {
        if (cancelled) return;
        subscription = Notifications.addNotificationResponseReceivedListener((response) => {
          listener({ data: response.notification.request.content.data });
        });
      });

      return () => {
        cancelled = true;
        subscription?.remove();
      };
    },

    clearBadge: async () => {
      const Notifications = await loadNotifications();
      await Notifications.setBadgeCountAsync(0);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The fake                                                                   */
/* -------------------------------------------------------------------------- */

export interface FakeNotificationsAdapter extends PushNotificationsAdapter {
  /** Pretend the guest answered the system prompt this way. */
  setPermission: (snapshot: PushPermissionSnapshot) => void;
  /** Deliver a tap to whatever the provider subscribed. */
  emitResponse: (data: unknown) => void;
  readonly calls: {
    configure: number;
    requestPermission: number;
    getToken: number;
    clearBadge: number;
  };
  /** The next token `getToken` hands out. `null` fakes a simulator. */
  nextToken: string | null;
  lastResponse: PushResponse | null;
}

/**
 * An adapter that answers instantly and records what it was asked.
 *
 * Used by `src/test/push-lifecycle.test.tsx`, which is the only place the
 * registration sequence is checked end to end.
 */
export function createFakeNotificationsAdapter(
  initial: PushPermissionSnapshot = { permission: "undetermined", canAskAgain: true },
): FakeNotificationsAdapter {
  let snapshot = initial;
  const listeners = new Set<(response: PushResponse) => void>();

  const fake: FakeNotificationsAdapter = {
    calls: { configure: 0, requestPermission: 0, getToken: 0, clearBadge: 0 },
    nextToken: "ExponentPushToken[fake-device-token]",
    lastResponse: null,

    setPermission: (next) => {
      snapshot = next;
    },
    emitResponse: (data) => {
      for (const listener of listeners) listener({ data });
    },

    configure: async () => {
      fake.calls.configure += 1;
    },
    getPermission: async () => snapshot,
    requestPermission: async () => {
      fake.calls.requestPermission += 1;
      // A real prompt only moves an undetermined permission; asking again after
      // a refusal returns the refusal, which is what the OS does.
      if (snapshot.permission === "undetermined") {
        snapshot = { permission: "granted", canAskAgain: false };
      }
      return snapshot;
    },
    getToken: async () => {
      fake.calls.getToken += 1;
      return fake.nextToken;
    },
    getLastResponse: async () => fake.lastResponse,
    addResponseListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearBadge: async () => {
      fake.calls.clearBadge += 1;
    },
  };

  return fake;
}
