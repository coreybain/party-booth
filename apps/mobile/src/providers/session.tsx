/**
 * Session + role context for the app shell.
 *
 * Sprint 1 knows about *authentication* (Better Auth) but not yet about *membership* —
 * events, memberships and roles land in Sprint 2. So `roles.eventRole` is always `null`
 * here, and there is a `__DEV__`-only override (see {@link useSession}'s
 * `setPreviewEventRole`) so the conditional Host tab can actually be exercised before
 * the real membership query exists.
 *
 * Two provider implementations exist on purpose:
 *   - {@link LiveSessionProvider} calls Better Auth's `useSession` hook.
 *   - {@link OfflineSessionProvider} supplies a static signed-out value.
 *
 * The choice is made once, above this file, based on whether the app is configured at
 * all. That keeps hook order stable — the branch is decided by bundle-time constants and
 * can never flip during a render.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { signOut as performSignOut, type AuthClient } from "../lib/auth-client";
import { ANONYMOUS_ROLE_CONTEXT, type EventRole, type RoleContext } from "../lib/roles";

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
       * True until the guest has confirmed their display name and photo
       * (PLAN.md → "then name + photo confirmation").
       */
      readonly needsOnboarding: boolean;
    };

export interface SessionValue {
  readonly state: SessionState;
  readonly roles: RoleContext;
  /** `false` when the app has no Convex/Better Auth configuration at all. */
  readonly configured: boolean;
  readonly signOut: () => Promise<void>;
  /** `__DEV__` affordance for previewing the Host tab before Sprint 2. No-op in release. */
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

/**
 * Shared state that both provider variants need: the dev-only role preview and the
 * derived `RoleContext`.
 */
function usePreviewRoles(): {
  roles: RoleContext;
  previewEventRole: EventRole | null;
  setPreviewEventRole: (role: EventRole | null) => void;
} {
  const [previewEventRole, setPreviewRole] = useState<EventRole | null>(null);

  const setPreviewEventRole = useCallback((role: EventRole | null) => {
    if (!__DEV__) return;
    setPreviewRole(role);
  }, []);

  const roles = useMemo<RoleContext>(
    () => ({
      ...ANONYMOUS_ROLE_CONTEXT,
      // Sprint 2 replaces this with the membership for the active event.
      eventRole: __DEV__ ? previewEventRole : null,
    }),
    [previewEventRole],
  );

  return { roles, previewEventRole, setPreviewEventRole };
}

/** Provider used when Convex + Better Auth are configured. */
export function LiveSessionProvider({
  authClient,
  children,
}: {
  authClient: AuthClient;
  children: ReactNode;
}) {
  const { data, isPending } = authClient.useSession();
  const { roles, previewEventRole, setPreviewEventRole } = usePreviewRoles();

  const signOut = useCallback(async () => {
    await performSignOut(authClient);
  }, [authClient]);

  const state = useMemo<SessionState>(() => {
    if (isPending) return { status: "loading" };
    const user = data?.user;
    if (!user) return { status: "signed-out" };

    const name = user.name && user.name.trim().length > 0 ? user.name : null;
    const image = user.image ?? null;

    return {
      status: "signed-in",
      user: { id: user.id, name, email: user.email ?? null, image },
      // Sprint 2 replaces this with an explicit `onboardedAt` on the Convex user record:
      // an Apple private-relay user may legitimately have no name from the provider, and
      // we must not re-prompt someone who deliberately skipped adding a photo.
      needsOnboarding: name === null,
    };
  }, [data, isPending]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      roles,
      configured: true,
      signOut,
      setPreviewEventRole,
      previewEventRole,
    }),
    [state, roles, signOut, setPreviewEventRole, previewEventRole],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Provider used when the app has no backend configuration — always signed out. */
export function OfflineSessionProvider({ children }: { children: ReactNode }) {
  const { roles, previewEventRole, setPreviewEventRole } = usePreviewRoles();

  const value = useMemo<SessionValue>(
    () => ({
      state: { status: "signed-out" },
      roles,
      configured: false,
      signOut: async () => {},
      setPreviewEventRole,
      previewEventRole,
    }),
    [roles, setPreviewEventRole, previewEventRole],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
