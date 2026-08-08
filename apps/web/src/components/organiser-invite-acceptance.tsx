"use client";

import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { BackendGate } from "@/components/backend-gate";
import { Callout } from "@/components/ui/callout";
import { backendApi } from "@/lib/convex-api";

export function OrganiserInviteAcceptance({ token }: { readonly token: string }) {
  return (
    <BackendGate>
      <OrganiserInviteAcceptanceLive token={token} />
    </BackendGate>
  );
}

function OrganiserInviteAcceptanceLive({ token }: { readonly token: string }) {
  const prepare = useAction(backendApi.organiser_invitations.prepare);
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void prepare({ token })
      .then((result) => {
        if (!result.ok) {
          setFailed(true);
          return;
        }
        window.location.replace(result.verifyPath);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [prepare, token]);

  return failed ? (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-ink">
        This invitation is no longer available
      </h1>
      <Callout tone="info" className="mt-4">
        Ask the PartyBooth administrator to send you a new host invitation.
      </Callout>
    </>
  ) : (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Accepting your invitation…</h1>
      <p className="mt-1 text-sm text-muted">
        This link signs you in and activates host access automatically.
      </p>
    </>
  );
}
