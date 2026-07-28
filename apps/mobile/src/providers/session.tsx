/**
 * Session, membership and role context for the app shell.
 *
 * Sprint 1 knew about *authentication* only. Sprint 2 adds the other two axes the
 * shell needs, and both come from Convex rather than from device state:
 *
 *   - **Which parties this account is in** (`events.myEvents`), so the switcher can
 *     list them, and
 *   - **Which one it is pointed at** (`events.activeEvent` / `events.setActiveEvent`),
 *     which is stored per *user*, not per install. A host moderating on their phone
 *     and presenting from a laptop should not have to pick the party twice.
 *
 * `roles.eventRole` is now the caller's real membership role for the active event,
 * which is what makes the Host tab appear for an owner or a co-host — including a
 * co-host who was invited by email before they ever had an account, because
 * `users.refreshRoles` re-runs verified-email matching on launch and the membership
 * row is upgraded server-side.
 *
 * Two provider implementations still exist, and the choice is still made once, above
 * this file, on a bundle-time constant:
 *   - {@link LiveSessionProvider} — Better Auth + Convex subscriptions.
 *   - {@link OfflineSessionProvider} — a static signed-out value, no clients at all.
 * That keeps hook order stable; the branch can never flip during a render.
 */

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { OptimisticLocalStore } from "convex/browser";

import { api, type EventId, type EventSummary } from "../lib/api";
import { signOut as performSignOut, type ActionOutcome, type AuthClient } from "../lib/auth-client";
import { describeError } from "../lib/errors";
import { resolveActiveEvent, sortEvents } from "../lib/events";
import { clearLocalProfile, loadLocalProfile, saveLocalProfile } from "../lib/local-profile";
import { EMPTY_LOCAL_PROFILE, readDisplayName, type LocalProfile } from "../lib/profile";
import { ANONYMOUS_ROLE_CONTEXT, type EventRole, type RoleContext } from "../lib/roles";
import { captureHandledError } from "../lib/sentry";

import type { ReactNode } from "react";

export interface SessionUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | {
      readonly status: "signed-in";
      readonly user: SessionUser;
      /**
       * True until the guest has confirmed their display name
       * (PLAN.md → "then name + photo confirmation").
       *
       * Answered by `users.onboardedAt`, not by anything on this device: a
       * reinstall must not re-prompt somebody who has already told us their
       * name, and a guest who onboards on their phone should not be asked
       * again on mobile web.
       */
      readonly needsOnboarding: boolean;
    };

/** What the onboarding screen sends. `photoUri` is a device path — see `profile.ts`. */
export interface ProfileConfirmation {
  readonly displayName: string;
  readonly photoUri: string | null;
}

export interface SessionValue {
  readonly state: SessionState;
  readonly roles: RoleContext;
  /** `false` when the app has no Convex/Better Auth configuration at all. */
  readonly configured: boolean;

  /** Every party this account is an active member of, newest first. */
  readonly events: readonly EventSummary[];
  /** The one the Camera and Host tabs act on. `null` before the first join. */
  readonly activeEvent: EventSummary | null;
  /** True while the membership subscriptions have not produced a first value. */
  readonly eventsLoading: boolean;
  /** Persist a different active event. Resolves once the server has it. */
  readonly selectEvent: (eventId: EventId | null) => Promise<ActionOutcome>;

  /** The locally-remembered avatar choice, until Sprint 3 can upload it. */
  readonly localProfile: LocalProfile;
  /** Save the name (to Convex) and the photo (locally, until Sprint 3). */
  readonly confirmProfile: (input: ProfileConfirmation) => Promise<ActionOutcome>;

  readonly signOut: () => Promise<void>;
  /** `__DEV__` affordance for previewing the Host tab with no membership. */
  readonly setPreviewEventRole: (role: EventRole | null) => void;
  readonly previewEventRole: EventRole | null;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside a session provider (see app/_layout.tsx).");
  }
  return value;
}

/** Convenience: the role context the permission helpers take. */
export function useRoles(): RoleContext {
  return useSession().roles;
}

/** Convenience for screens that only care about which party is selected. */
export function useActiveEvent(): EventSummary | null {
  return useSession().activeEvent;
}

/* -------------------------------------------------------------------------- */
/* Dev-only role preview                                                      */
/* -------------------------------------------------------------------------- */

function usePreviewEventRole(): {
  previewEventRole: EventRole | null;
  setPreviewEventRole: (role: EventRole | null) => void;
} {
  const [previewEventRole, setPreviewRole] = useState<EventRole | null>(null);

  const setPreviewEventRole = useCallback((role: EventRole | null) => {
    if (!__DEV__) return;
    setPreviewRole(role);
  }, []);

  return { previewEventRole, setPreviewEventRole };
}

/**
 * Fold the account axis, the membership axis and the dev override into the single
 * `RoleContext` the contracts-backed helpers in `src/lib/roles.ts` consume.
 *
 * The preview role only applies when there is **no real membership**. Letting it
 * override a genuine `guest` role would mean a developer testing the Host tab sees
 * affordances the same build denies a real guest — the exact bug the preview exists
 * to avoid needing.
 */
function toRoleContext(params: {
  readonly activeEvent: EventSummary | null;
  readonly isGlobalAdmin: boolean;
  readonly accountLocked: boolean;
  readonly previewEventRole: EventRole | null;
}): RoleContext {
  const realRole = params.activeEvent?.role ?? null;
  const eventRole = realRole ?? (__DEV__ ? params.previewEventRole : null);

  return {
    ...ANONYMOUS_ROLE_CONTEXT,
    accountRole: params.isGlobalAdmin ? "globalAdmin" : "member",
    eventRole,
    accountLocked: params.accountLocked,
  };
}

/* -------------------------------------------------------------------------- */
/* Active event                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Point the header at the chosen party the instant it is tapped.
 *
 * Convex's own optimistic-update mechanism rather than a second copy of the active
 * event in component state: it applies the change to the `events.activeEvent`
 * subscription, drops it when the real value arrives, and — the part worth having —
 * rolls it back automatically if the mutation fails. A hand-rolled "pending id" has to
 * get all three right, and gets the third one wrong the first time somebody switches
 * to a party a rotation has just removed them from.
 *
 * Declared at module scope because `withOptimisticUpdate` is called during render;
 * an inline closure would hand `useCallback` a new mutation on every pass.
 */
function optimisticallySetActiveEvent(
  localStore: OptimisticLocalStore,
  args: { eventId: EventId | null },
): void {
  if (args.eventId === null) {
    localStore.setQuery(api.events.activeEvent, {}, null);
    return;
  }
  const known = localStore.getQuery(api.events.myEvents, {});
  const next = known?.find((event) => event.id === args.eventId);
  // Only when the party is already in the list. Synthesising a summary here would put
  // a half-built event in the header for a frame, which is worse than a beat of lag.
  if (next) localStore.setQuery(api.events.activeEvent, {}, next);
}

/* -------------------------------------------------------------------------- */
/* Local profile                                                              */
/* -------------------------------------------------------------------------- */

interface LoadedProfile {
  readonly userId: string;
  readonly profile: LocalProfile;
}

/**
 * Read the locally-remembered profile for the signed-in account.
 *
 * The loaded value carries the id it belongs to, so switching accounts *derives* a
 * reset rather than performing one: no effect ever clears state synchronously, and
 * there is no window in which the previous guest's avatar is attributed to the new one.
 */
function useLocalProfile(userId: string | null): {
  readonly profile: LocalProfile;
  /** False only while the keychain read for the current account is in flight. */
  readonly loaded: boolean;
  readonly setProfile: (profile: LocalProfile) => void;
} {
  const [loadedProfile, setLoadedProfile] = useState<LoadedProfile | null>(null);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    void loadLocalProfile(userId).then((profile) => {
      if (!cancelled) setLoadedProfile({ userId, profile });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const current = loadedProfile?.userId === userId ? loadedProfile : null;

  const setProfile = useCallback(
    (profile: LocalProfile) => {
      if (userId !== null) setLoadedProfile({ userId, profile });
    },
    [userId],
  );

  return {
    profile: current?.profile ?? EMPTY_LOCAL_PROFILE,
    loaded: userId === null || current !== null,
    setProfile,
  };
}

/* -------------------------------------------------------------------------- */
/* Live provider                                                              */
/* -------------------------------------------------------------------------- */

/** Provider used when Convex + Better Auth are configured. */
export function LiveSessionProvider({
  authClient,
  children,
}: {
  authClient: AuthClient;
  children: ReactNode;
}) {
  const { data, isPending } = authClient.useSession();
  // Convex's *own* view of authentication, not Better Auth's. The two are not the same
  // instant: Better Auth can have a session a beat before the token has reached Convex.
  const { isAuthenticated } = useConvexAuth();
  const { previewEventRole, setPreviewEventRole } = usePreviewEventRole();

  const authUser = data?.user ?? null;
  const authUserId = authUser?.id ?? null;
  const signedIn = !isPending && authUser !== null;

  // Every Convex call below is skipped until Convex itself says the caller is
  // authenticated. `events.myEvents` and friends call `requireUser`, which throws
  // `unauthenticated` — and a Convex query that throws throws during *render*, taking
  // the whole shell down with it. Gating on `isAuthenticated` rather than on Better
  // Auth's `signedIn` closes the window between the two. "skip" is the supported way
  // to say "not yet".
  const skip = isAuthenticated ? {} : "skip";
  const currentUser = useQuery(api.users.currentUser, skip);
  const myEvents = useQuery(api.events.myEvents, skip);
  const serverActiveEvent = useQuery(api.events.activeEvent, skip);

  const setActiveEvent = useMutation(api.events.setActiveEvent).withOptimisticUpdate(
    optimisticallySetActiveEvent,
  );
  const refreshRoles = useMutation(api.users.refreshRoles);
  const updateProfile = useMutation(api.users.updateProfile);

  const { profile, loaded: profileLoaded, setProfile } = useLocalProfile(authUserId);

  /* ---------------------------------------------------------------- */
  /* Verified-email matching                                          */
  /* ---------------------------------------------------------------- */

  // `users.refreshRoles` re-runs verified-email matching for this account. The Better
  // Auth triggers already cover "invited yesterday, signs in today"; this covers the
  // other order — "signed in last week, invited five minutes ago" — which is exactly
  // how a co-host gets added during a party. It is idempotent (an invitation is
  // consumed by being accepted), so once per signed-in account per launch is right.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || authUserId === null || refreshedFor.current === authUserId) return;
    refreshedFor.current = authUserId;
    void refreshRoles({}).catch((error: unknown) => {
      // A missed match costs host powers until the next launch, not access. Never
      // worth interrupting someone who has just walked through the door.
      captureHandledError(error, { scope: "session.refreshRoles" });
    });
  }, [isAuthenticated, authUserId, refreshRoles]);

  /* ---------------------------------------------------------------- */
  /* Active event                                                     */
  /* ---------------------------------------------------------------- */

  const events = useMemo(() => sortEvents(myEvents ?? []), [myEvents]);

  // `events.activeEvent` is the authority, resolved back against the list by id so the
  // switcher's highlight and the header's title cannot disagree during the beat where
  // one subscription has updated and the other has not. `resolveActiveEvent` also
  // self-heals a stale selection — an archived party, or a membership a rotation
  // revoked — by falling back to the newest one this account can actually use.
  const activeEvent = useMemo(
    () => resolveActiveEvent(events, serverActiveEvent?.id ?? null),
    [events, serverActiveEvent],
  );

  const selectEvent = useCallback(
    async (eventId: EventId | null): Promise<ActionOutcome> => {
      try {
        // The optimistic update above has already moved the header; Convex rolls it
        // back on its own if this throws.
        await setActiveEvent({ eventId });
        return { status: "ok" };
      } catch (error) {
        captureHandledError(error, { scope: "session.selectEvent" });
        return { status: "error", message: describeError(error).message };
      }
    },
    [setActiveEvent],
  );

  /* ---------------------------------------------------------------- */
  /* Profile                                                          */
  /* ---------------------------------------------------------------- */

  const confirmProfile = useCallback(
    async ({ displayName, photoUri }: ProfileConfirmation): Promise<ActionOutcome> => {
      const name = readDisplayName(displayName, true);
      if (!name.valid) return { status: "error", message: name.error ?? "Enter a name." };
      if (authUserId === null) {
        return { status: "error", message: "Sign in again to save your profile." };
      }

      // `users.updateProfile` is the single writer of `users.displayName` — the
      // column every membership list, moderation queue and audit row reads, and
      // the one `apps/web`'s name-confirm form writes too. It also stamps
      // `onboardedAt`, which is what makes "has this guest confirmed a name?" a
      // server-side fact rather than a device-local flag a reinstall loses.
      //
      // The photo does *not* go with it: `avatarKey` is an UploadThing key, and
      // the picker hands back a `file://` path that no other device can resolve.
      // Sprint 3 builds the upload, and the argument is already there for it.
      try {
        await updateProfile({ displayName: name.value });
      } catch (error) {
        captureHandledError(error, { scope: "session.confirmProfile" });
        return { status: "error", message: describeError(error).message };
      }

      if (photoUri !== null) {
        const next: LocalProfile = { photoUri };
        setProfile(next);
        await saveLocalProfile(authUserId, next);
      }
      return { status: "ok" };
    },
    [authUserId, setProfile, updateProfile],
  );

  const signOut = useCallback(async () => {
    await performSignOut(authClient);
    // The next person to sign in on this phone starts with their own avatar, not the
    // last guest's. A party is exactly where a phone gets handed around.
    if (authUserId !== null) await clearLocalProfile(authUserId);
    refreshedFor.current = null;
  }, [authClient, authUserId]);

  /* ---------------------------------------------------------------- */
  /* Assembled value                                                  */
  /* ---------------------------------------------------------------- */

  const state = useMemo<SessionState>(() => {
    if (isPending) return { status: "loading" };
    if (!authUser) return { status: "signed-out" };
    // Holding "loading" over the keychain read stops a confirmed guest being bounced
    // through the onboarding screen for a frame on every cold start.
    if (!profileLoaded) return { status: "loading" };
    // Same reason, for the server half: `undefined` is "still asking", and
    // guessing `needsOnboarding` while the answer is in flight is exactly how a
    // guest who has already given their name gets asked for it again.
    if (currentUser === undefined) return { status: "loading" };

    // The confirmed name outranks the provider's — `users.updateProfile` is the
    // only writer of `displayName`, and `auth.ts` defers to it.
    const name =
      currentUser?.displayName ??
      (authUser.name && authUser.name.trim().length > 0 ? authUser.name : null);

    return {
      status: "signed-in",
      user: {
        id: authUser.id,
        name,
        email: currentUser?.email ?? authUser.email ?? null,
        image: authUser.image ?? null,
      },
      // `null` means the mirrored row has not appeared yet, which is the same
      // situation as never having onboarded: there is nothing to skip past.
      needsOnboarding: currentUser === null || currentUser.onboardedAt === undefined,
    };
  }, [authUser, currentUser, isPending, profileLoaded]);

  const roles = useMemo(
    () =>
      toRoleContext({
        activeEvent,
        isGlobalAdmin: currentUser?.isGlobalAdmin ?? false,
        accountLocked: currentUser?.accountState === "locked",
        previewEventRole,
      }),
    [activeEvent, currentUser, previewEventRole],
  );

  const value = useMemo<SessionValue>(
    () => ({
      state,
      roles,
      configured: true,
      events,
      activeEvent,
      eventsLoading: signedIn && myEvents === undefined,
      selectEvent,
      localProfile: profile,
      confirmProfile,
      signOut,
      setPreviewEventRole,
      previewEventRole,
    }),
    [
      state,
      roles,
      events,
      activeEvent,
      signedIn,
      myEvents,
      selectEvent,
      profile,
      confirmProfile,
      signOut,
      setPreviewEventRole,
      previewEventRole,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/* -------------------------------------------------------------------------- */
/* Offline provider                                                           */
/* -------------------------------------------------------------------------- */

const NOT_CONFIGURED: ActionOutcome = {
  status: "error",
  message: "This build has no backend configured, so nothing can be saved.",
};

/** Provider used when the app has no backend configuration — always signed out. */
export function OfflineSessionProvider({ children }: { children: ReactNode }) {
  const { previewEventRole, setPreviewEventRole } = usePreviewEventRole();

  const roles = useMemo(
    () =>
      toRoleContext({
        activeEvent: null,
        isGlobalAdmin: false,
        accountLocked: false,
        previewEventRole,
      }),
    [previewEventRole],
  );

  const value = useMemo<SessionValue>(
    () => ({
      state: { status: "signed-out" },
      roles,
      configured: false,
      events: [],
      activeEvent: null,
      eventsLoading: false,
      selectEvent: async () => NOT_CONFIGURED,
      localProfile: EMPTY_LOCAL_PROFILE,
      confirmProfile: async () => NOT_CONFIGURED,
      signOut: async () => {},
      setPreviewEventRole,
      previewEventRole,
    }),
    [roles, setPreviewEventRole, previewEventRole],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
