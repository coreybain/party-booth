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
import { createContext, useContext } from "react";
import { ConvexProvider } from "convex/react";

import type { AuthClient as ConvexCompatibleAuthClient } from "@convex-dev/better-auth/react";

import { appConfig } from "../env";
import { getAuthClient, type AuthClient } from "../lib/auth-client";
import { getConvexClient } from "../lib/convex";
import { ConnectedPushProvider } from "../push/provider";
import { ConnectedUploadQueue, OfflineUploadQueue } from "../upload/queue-provider";

import { LiveSessionProvider, OfflineSessionProvider } from "./session";

import type { ReadyAppConfig } from "../lib/config";
import type { ReactNode } from "react";

const AuthClientContext = createContext<AuthClient | null>(null);

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
            {/* Inside Convex (it needs `useMutation`) and inside the session
                (a grant is only issued to an authenticated member), but above
                the router, because the queue outlives any screen — a capture
                keeps uploading while the guest is on the Photos tab. */}
            <ConnectedUploadQueue siteUrl={config.siteUrl}>
              {/* Same three reasons, plus one of its own: a notification tap
                  navigates, so this has to sit above the router that answers
                  it. `projectId` undefined means the build has no EAS project
                  and the whole subsystem stays inert. */}
              <ConnectedPushProvider projectId={config.easProjectId}>
                {children}
              </ConnectedPushProvider>
            </ConnectedUploadQueue>
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
