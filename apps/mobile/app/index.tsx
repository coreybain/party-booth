import { Redirect, useRouter } from "expo-router";
import { useState } from "react";

import { SetupRequired } from "@/components/setup-required";
import { Loading } from "@/components/ui";
import { appConfig } from "@/env";
import { useSession } from "@/providers/session";

/**
 * Entry gate.
 *
 * Order matters: configuration first (nothing works without it), then session, then
 * onboarding. Each branch is a `<Redirect>` rather than an imperative navigation so the
 * decision is re-evaluated whenever the session changes — signing out anywhere in the
 * app lands back here and falls through to `/sign-in`.
 */
export default function IndexRoute() {
  const router = useRouter();
  const { state } = useSession();
  const [bypassSetup, setBypassSetup] = useState(false);

  if (appConfig.status === "unconfigured" && !bypassSetup) {
    return (
      <SetupRequired
        missing={appConfig.missing}
        onContinueAnyway={() => {
          setBypassSetup(true);
          router.replace("/camera");
        }}
      />
    );
  }

  if (state.status === "loading") return <Loading label="Restoring your session…" />;
  if (state.status === "signed-out") return <Redirect href="/sign-in" />;
  if (state.needsOnboarding) return <Redirect href="/onboarding" />;

  return <Redirect href="/camera" />;
}
