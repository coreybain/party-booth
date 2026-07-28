/**
 * The push lifecycle, wired to React, Convex and the OS.
 *
 * Everything decidable with values lives elsewhere and is unit-tested —
 * `./registration` (when to ask, when to register), `./routing` (where a tap
 * goes), `./state` (what survives a restart). What is here is the part that
 * cannot be: effects, a native module, a router and two mutations.
 *
 * ## The sequence, once
 *
 * 1. **Configure** — foreground presentation and the Android channel. Before
 *    anything can arrive.
 * 2. **Ask the OS what it already thinks.** Never a prompt; a launch must never
 *    produce one.
 * 3. **`nextRegistrationStep`** decides between doing nothing, prompting (only
 *    if a join has armed it), registering, or accepting a refusal.
 * 4. **Register** — mint a token and send it to Convex. Once per launch per
 *    token, because the token can rotate under the app and a stale row is a
 *    notification delivered to nobody.
 *
 * ## Two things are deliberately *not* here
 *
 * **The prompt is not fired by this file's own effects.** It is armed by
 * `useJoinEvent` on a successful join and fires on the effect that follows,
 * which is the difference between asking a stranger and asking a guest.
 *
 * **Nothing throws onto anybody's path.** A phone with no notification
 * permission, a simulator with no token, a deployment with no Expo project and a
 * dropped connection are the *normal* states of most installs, and none of them
 * is allowed to interrupt a party.
 */

import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";

import type { PushPlatform } from "@partybooth/contracts/schemas";

import { api } from "../lib/api";
import { captureHandledError } from "../lib/sentry";
import { useSession } from "../providers/session";
import { readStoreFile, writeStoreFile } from "../upload/device-store";

import { createExpoNotificationsAdapter, type PushNotificationsAdapter } from "./adapter";
import { setPushDetachHandler } from "./detach";
import {
  nextRegistrationStep,
  shouldSendToken,
  type PushPermission,
  type RegistrationStep,
} from "./registration";
import { routeForPush } from "./routing";
import {
  EMPTY_PUSH_STATE,
  isArmed,
  parsePushState,
  PUSH_STATE_FILE_NAME,
  serialisePushState,
  type PushDeviceState,
} from "./state";

import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* The backend seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The two Convex calls, passed in rather than called directly — the same shape
 * `UploadQueueProvider` uses, and for the same two reasons: a build with no
 * Convex client mounts no provider to call `useMutation` under, and the tests
 * need somewhere to stand.
 */
export interface PushBackend {
  readonly registerDevice: (args: {
    expoPushToken: string;
    platform: PushPlatform;
  }) => Promise<unknown>;
  readonly unregisterDevice: (args: { expoPushToken: string }) => Promise<unknown>;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export interface PushValue {
  /** What the OS currently says. `undetermined` until the first check lands. */
  readonly permission: PushPermission;
  /** What the app is doing about it. Rendered by Settings, nowhere else. */
  readonly step: RegistrationStep;
  /** True once a token has reached Convex on this launch. */
  readonly registered: boolean;
  /**
   * Record that a join has happened, earning the right to prompt.
   *
   * Idempotent and fire-and-forget: `useJoinEvent` calls it on every successful
   * join, and only the first one changes anything.
   */
  readonly armPrompt: () => void;
  /**
   * Ask now, from a button rather than from a join.
   *
   * Settings offers this so somebody who declined — or who joined before this
   * build existed — has a way back that is not "reinstall the app".
   */
  readonly enableNotifications: () => Promise<void>;
}

/**
 * The inert value. A screen rendered outside the provider — an unconfigured
 * build, or a test that mounts one screen — gets a push system that does
 * nothing, rather than a thrown error from a hook it never asked to depend on.
 */
const INERT: PushValue = {
  permission: "undetermined",
  step: "idle",
  registered: false,
  armPrompt: () => {},
  enableNotifications: async () => {},
};

const PushContext = createContext<PushValue>(INERT);

export function usePush(): PushValue {
  return useContext(PushContext);
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

/** `PushPlatform` is `ios | android`; the web bundle is neither and never registers. */
function currentPlatform(): PushPlatform | null {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return null;
}

export function PushProvider({
  backend,
  projectId,
  adapter,
  children,
}: {
  /** `null` when there is no Convex client — the queue's convention. */
  readonly backend: PushBackend | null;
  /** The EAS project id. `null` disables push entirely, with no error. */
  readonly projectId: string | null;
  /** Injected by the tests; defaults to the real `expo-notifications`. */
  readonly adapter?: PushNotificationsAdapter;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const { state, selectEvent } = useSession();
  const signedIn = state.status === "signed-in";

  // Constructed once. A new adapter per render would re-subscribe the response
  // listener on every commit, and on a real device that means a tap handled
  // twice.
  const [fallbackAdapter] = useState(createExpoNotificationsAdapter);
  const notifications = adapter ?? fallbackAdapter;

  const [stored, setStored] = useState<PushDeviceState>(EMPTY_PUSH_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [permission, setPermission] = useState<PushPermission>("undetermined");
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [registered, setRegistered] = useState(false);

  /*
   * Mirrors of the state the async sequence reads across awaits. Written in an
   * effect rather than during render, for the reason `queue-provider.tsx` sets
   * out at length: React 19 may start a render, throw it away and start again,
   * and a ref assigned during a discarded render would leave this holding a
   * token that was never committed.
   */
  const storedRef = useRef(stored);
  useEffect(() => {
    storedRef.current = stored;
  }, [stored]);

  /** Guards the sequence: one attempt at a time, and one prompt ever. */
  const runningRef = useRef(false);
  const sentTokenRef = useRef<string | null>(null);

  const persist = useCallback((next: PushDeviceState) => {
    setStored(next);
    storedRef.current = next;
    void writeStoreFile(PUSH_STATE_FILE_NAME, serialisePushState(next));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Hydration and one-time configuration                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await readStoreFile(PUSH_STATE_FILE_NAME);
      if (cancelled) return;
      setStored(parsePushState(raw));
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        await notifications.configure();
        const snapshot = await notifications.getPermission();
        if (cancelled) return;
        setPermission(snapshot.permission);
        setCanAskAgain(snapshot.canAskAgain);
      } catch (error) {
        captureHandledError(error, { scope: "push.configure" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notifications, projectId]);

  /* ---------------------------------------------------------------- */
  /* Registering                                                      */
  /* ---------------------------------------------------------------- */

  const sendToken = useCallback(async (): Promise<void> => {
    if (backend === null || projectId === null) return;
    const platform = currentPlatform();
    if (platform === null) return;

    const token = await notifications.getToken(projectId);
    // A simulator, or Expo unreachable. Neither is an error and neither is
    // worth telling anybody about — the next launch tries again.
    if (token === null) return;

    if (!shouldSendToken(token, { token: sentTokenRef.current ?? undefined, thisLaunch: true })) {
      setRegistered(true);
      return;
    }

    await backend.registerDevice({ expoPushToken: token, platform });
    sentTokenRef.current = token;
    setRegistered(true);
    // Remembered so sign-out can retire exactly this token without asking Expo
    // for it again at the worst possible moment.
    if (storedRef.current.token !== token) {
      persist({ ...storedRef.current, token });
    }
  }, [backend, notifications, persist, projectId]);

  const requestPermission = useCallback(async (): Promise<void> => {
    const snapshot = await notifications.requestPermission();
    setPermission(snapshot.permission);
    setCanAskAgain(snapshot.canAskAgain);
    // Stamped whatever the answer, so a refusal is not re-asked on every launch.
    persist({ ...storedRef.current, promptedAt: Date.now() });
  }, [notifications, persist]);

  const step = useMemo<RegistrationStep>(
    () =>
      nextRegistrationStep({
        configured: projectId !== null && backend !== null,
        signedIn,
        permission,
        canAskAgain,
        // A prompt that has already been shown does not re-arm on the next
        // launch: the OS answer is the answer, and Settings is the way back.
        armed: isArmed(stored) && stored.promptedAt === undefined,
      }),
    [backend, canAskAgain, permission, projectId, signedIn, stored],
  );

  useEffect(() => {
    if (!hydrated || runningRef.current) return;
    if (step !== "prompt" && step !== "register") return;

    runningRef.current = true;
    void (async () => {
      try {
        if (step === "prompt") await requestPermission();
        else await sendToken();
      } catch (error) {
        // Registration is best-effort by design. A failure here costs
        // notifications, not the party.
        captureHandledError(error, { scope: "push.register", step });
      } finally {
        runningRef.current = false;
      }
    })();
  }, [hydrated, requestPermission, sendToken, step]);

  /* ---------------------------------------------------------------- */
  /* Sign-out                                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (backend === null) {
      setPushDetachHandler(null);
      return () => setPushDetachHandler(null);
    }
    setPushDetachHandler(async () => {
      const token = storedRef.current.token ?? sentTokenRef.current;
      if (token === undefined || token === null) return;
      // Before the session goes: `push.unregisterDevice` is authenticated, and
      // it deletes the row rather than disabling it, so the next person to sign
      // in on this phone does not inherit somebody else's notifications.
      await backend.unregisterDevice({ expoPushToken: token });
      sentTokenRef.current = null;
      setRegistered(false);
      persist({ ...storedRef.current, token: undefined });
    });
    return () => setPushDetachHandler(null);
  }, [backend, persist]);

  /* ---------------------------------------------------------------- */
  /* Taps                                                             */
  /* ---------------------------------------------------------------- */

  const openFromNotification = useCallback(
    (data: unknown) => {
      const route = routeForPush(data);
      if (route === null) return;

      void (async () => {
        // The party first, the screen second. The Host tab renders whatever the
        // shell's active event is, so navigating first would show the wrong
        // party's queue — and if the switch then failed, keep showing it.
        if (route.eventId !== null) await selectEvent(route.eventId);
        router.navigate(route.path);
      })();
    },
    [router, selectEvent],
  );

  useEffect(() => {
    if (projectId === null) return;
    return notifications.addResponseListener((response) => {
      openFromNotification(response.data);
    });
  }, [notifications, openFromNotification, projectId]);

  // The tap that launched the app from cold. `addResponseListener` does not
  // replay it, so without this a notification tapped from a killed app opens on
  // whatever screen the shell restores.
  const coldStartHandled = useRef(false);
  useEffect(() => {
    if (projectId === null || coldStartHandled.current) return;
    coldStartHandled.current = true;
    void (async () => {
      try {
        const response = await notifications.getLastResponse();
        if (response !== null) openFromNotification(response.data);
      } catch (error) {
        captureHandledError(error, { scope: "push.coldStart" });
      }
    })();
  }, [notifications, openFromNotification, projectId]);

  /* ---------------------------------------------------------------- */
  /* Badge                                                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (projectId === null) return;
    const clear = () => {
      void notifications.clearBadge().catch(() => {
        // A badge that will not clear is cosmetic. Nothing to report.
      });
    };
    clear();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") clear();
    });
    return () => subscription.remove();
  }, [notifications, projectId]);

  /* ---------------------------------------------------------------- */
  /* Assembled value                                                  */
  /* ---------------------------------------------------------------- */

  const armPrompt = useCallback(() => {
    if (isArmed(storedRef.current)) return;
    persist({ ...storedRef.current, armedAt: Date.now() });
  }, [persist]);

  const enableNotifications = useCallback(async () => {
    try {
      if (permission !== "granted") await requestPermission();
      await sendToken();
    } catch (error) {
      captureHandledError(error, { scope: "push.enable" });
    }
  }, [permission, requestPermission, sendToken]);

  const value = useMemo<PushValue>(
    () => ({ permission, step, registered, armPrompt, enableNotifications }),
    [armPrompt, enableNotifications, permission, registered, step],
  );

  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The provider with Convex attached. Mounted only inside the configured tree,
 * because `useMutation` needs a `ConvexProvider` above it.
 */
export function ConnectedPushProvider({
  projectId,
  children,
}: {
  readonly projectId: string | undefined;
  readonly children: ReactNode;
}) {
  const registerDevice = useMutation(api.push.registerDevice);
  const unregisterDevice = useMutation(api.push.unregisterDevice);

  const backend = useMemo<PushBackend>(
    () => ({
      registerDevice: (args) => registerDevice(args),
      unregisterDevice: (args) => unregisterDevice(args),
    }),
    [registerDevice, unregisterDevice],
  );

  return (
    <PushProvider backend={backend} projectId={projectId ?? null}>
      {children}
    </PushProvider>
  );
}
