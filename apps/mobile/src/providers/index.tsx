/**
 * Root provider tree.
 *
 * The whole tree branches once, at bundle time, on whether `EXPO_PUBLIC_CONVEX_URL` and
 * `EXPO_PUBLIC_SITE_URL` exist:
 *
 *   configured   → ConvexProvider → ConvexBetterAuthProvider → LiveSessionProvider
 *   unconfigured → OfflineSessionProvider (no clients constructed at all)
 *
 * Branching here rather than inside a provider is what lets the app boot with zero
 * credentials: `new ConvexReactClient(undefined)` would throw on import.
 */

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { createContext, useCallback, useContext } from "react";
import { ConvexProvider, useConvexAuth } from "convex/react";

import type { AuthClient as ConvexCompatibleAuthClient } from "@convex-dev/better-auth/react";

import { appConfig } from "../env";
import { authCookieHeaders, getAuthClient, type AuthClient } from "../lib/auth-client";
import { getConvexClient } from "../lib/convex";
import { ConnectedPushProvider } from "../push/provider";
import { ConnectedUploadQueue, OfflineUploadQueue } from "../upload/queue-provider";

import { LiveSessionProvider, OfflineSessionProvider, useSession } from "./session";

import type { ReadyAppConfig } from "../lib/config";
import type { ReactNode } from "react";

const AuthClientContext = createContext<AuthClient | null>(null);

/**
 * Services that must know exactly which authenticated account owns their local
 * state. This component is rendered below `LiveSessionProvider`, so it can pass
 * the Better Auth user id and Convex's independently-restored auth readiness to
 * the durable queue instead of letting the queue guess from configuration.
 */
function ConnectedServices({
  config,
  children,
}: {
  readonly config: ReadyAppConfig;
  readonly children: ReactNode;
}) {
  const { state } = useSession();
  const { isAuthenticated } = useConvexAuth();
  const authClient = useAuthClient();
  const ownerUserId = state.status === "signed-in" ? state.user.id : null;
  const uploadAuthHeaders = useCallback(
    () => (authClient === null ? {} : authCookieHeaders(authClient)),
    [authClient],
  );

  return (
    <ConnectedUploadQueue
      siteUrl={config.siteUrl}
      authHeaders={uploadAuthHeaders}
      ownerUserId={ownerUserId}
      enabled={isAuthenticated && ownerUserId !== null}
    >
      <ConnectedPushProvider projectId={config.easProjectId}>{children}</ConnectedPushProvider>
    </ConnectedUploadQueue>
  );
}

/**
 * The Better Auth client, or `null` when the app is unconfigured.
 *
 * Sign-in screens must handle `null` by rendering the "not configured" state rather than
 * disabling themselves silently.
 */
export function useAuthClient(): AuthClient | null {
  return useContext(AuthClientContext);
}

function ConfiguredProviders({
  config,
  children,
}: {
  config: ReadyAppConfig;
  children: ReactNode;
}) {
  // Both are memoised singletons, so calling them on every render is cheap and keeps the
  // clients out of module scope.
  const convex = getConvexClient(config.convexUrl);
  const authClient = getAuthClient(config.convexSiteUrl, config.scheme);

  return (
    <ConvexProvider client={convex}>
      {/*
        The cast is a declared-type gap, not a wiring mistake. `@convex-dev/better-auth`
        types its `authClient` prop as `createAuthClient<BetterAuthClientPlugin & {
        plugins: ... }>` — a shape that has no `baseURL`, while every client in their own
        Expo guide passes one. `ReactAuthClient` is invariant in its options parameter, so
        the extra key makes the two types unrelated even though the runtime object is
        exactly what the provider expects.

        Drop the cast once the prop type is widened upstream; if it ever fails at runtime
        it will do so loudly at the first authenticated query, not silently.
      */}
      <ConvexBetterAuthProvider
        client={convex}
        authClient={authClient as unknown as ConvexCompatibleAuthClient}
      >
        <AuthClientContext.Provider value={authClient}>
          <LiveSessionProvider authClient={authClient}>
            {/* The queue outlives every screen, but it does not outlive its
                owner: ConnectedServices gates it on Convex auth and scopes its
                persisted rows to the Better Auth user id. Push stays above the
                router because a notification tap navigates. */}
            <ConnectedServices config={config}>{children}</ConnectedServices>
          </LiveSessionProvider>
        </AuthClientContext.Provider>
      </ConvexBetterAuthProvider>
    </ConvexProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  if (appConfig.status === "unconfigured") {
    return (
      <AuthClientContext.Provider value={null}>
        <OfflineSessionProvider>
          {/* Still mounted with no backend: the camera works, captures persist,
              and the Photos tab explains why nothing is being sent. A missing
              provider would instead throw from `useUploadQueue` on the first
              screen of a fresh checkout. */}
          <OfflineUploadQueue>{children}</OfflineUploadQueue>
        </OfflineSessionProvider>
      </AuthClientContext.Provider>
    );
  }

  return <ConfiguredProviders config={appConfig}>{children}</ConfiguredProviders>;
}
