import { Redirect, useRouter } from "expo-router";
import { useState } from "react";

import { SetupRequired } from "@/components/setup-required";
import { Loading } from "@/components/ui";
import { appConfig } from "@/env";
import { pendingInviteParam, takePendingInvite } from "@/lib/pending-invite";
import { useSession } from "@/providers/session";

/**
 * Entry gate.
 *
 * Order matters: configuration first (nothing works without it), then session, then
 * onboarding, then any invite that was parked while the guest signed in. Each branch
 * is a `<Redirect>` rather than an imperative navigation so the decision is
 * re-evaluated whenever the session changes — signing out anywhere in the app lands
 * back here and falls through to `/sign-in`.
 *
 * The invite is consumed **last**, after onboarding, so a guest who scanned a QR and
 * had to sign in still gets asked for their name before they are dropped into a party
 * where the host will see it.
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

  // Reading clears it, so a later pass through this gate goes straight to the tabs
  // rather than re-opening a join screen the guest has already answered.
  const invite = takePendingInvite();
  if (invite) {
    return (
      <Redirect
        href={{ pathname: "/join/[token]", params: { token: pendingInviteParam(invite) } }}
      />
    );
  }

  return <Redirect href="/camera" />;
}
