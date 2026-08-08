"use client";

import { mobileAppDownloadsEnabled } from "@partybooth/env/client";
import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { BackendGate } from "@/components/backend-gate";
import { GuestSignIn } from "@/components/guest/guest-sign-in";
import { NameConfirmForm } from "@/components/guest/name-confirm-form";
import { EventPreviewCard } from "@/components/join/event-preview-card";
import { JoinLoading, JoinRejected, JoinThrottled } from "@/components/join/join-states";
import { OpenInApp } from "@/components/join/open-in-app";
import { OpenPartyBoothApp } from "@/components/join/open-partybooth-app";
import { PastEventGallery } from "@/components/join/past-event-gallery";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { backendApi } from "@/lib/convex-api";
import { JOIN_REJECTED_MESSAGE } from "@/lib/contracts";
import { joinUrl, mobileJoinUrl } from "@/lib/join-url";
import { useJoinAttempt } from "@/lib/use-join";

/**
 * The universal-link target, end to end.
 *
 * QR → this page → (sign in) → confirm your name → you're in. PLAN.md makes
 * this the **guaranteed** guest path for 5 August, so the ordering is chosen
 * for the door rather than for the code:
 *
 * 1. **Show the party first.** `previewByToken` is an unauthenticated query
 *    (the token is 160 bits — nothing to enumerate), so a guest sees "Corey's
 *    birthday, hosted by Corey, Wed 5 Aug" *before* being asked for anything.
 *    Asking for an email address in front of a blank screen is where people
 *    give up.
 * 2. **Sign in without leaving.** The OTP path stays on this page so the token
 *    never has to survive a round trip; Google necessarily leaves, so it comes
 *    back to this exact URL.
 * 3. **Then the name, then the join.** The name write is what the host reads in
 *    the moderation queue, and doing it before the membership exists means the
 *    queue never shows "j.smith82".
 *
 * The join call itself is not here: `useJoinAttempt` owns it, and the code-entry
 * page uses the same controller. Two copies of "call the mutation, read the
 * outcome, say something about it" is how one of them ends up more helpful than
 * the other, and a join path with two distinguishable answers is an enumeration
 * oracle.
 */
export function JoinByToken({ token }: { readonly token: string }) {
  // The Convex hooks below only exist inside a provider; see `BackendGate`.
  return (
    <BackendGate>
      <JoinByTokenLive token={token} />
    </BackendGate>
  );
}

function JoinByTokenLive({ token }: { readonly token: string }) {
  const showMobileAppDownloads = mobileAppDownloadsEnabled();
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();

  const preview = useQuery(backendApi.join.previewByToken, { token });
  const me = useQuery(backendApi.users.currentUser, isAuthenticated ? {} : "skip");
  const { phase, busy, attempt } = useJoinAttempt();

  const attemptJoin = useCallback(async () => {
    await attempt({ via: "token", token });
  }, [attempt, token]);

  /* --- Terminal states ---------------------------------------------------- */

  if (phase.status === "throttled") {
    return <JoinThrottled message={phase.message} retryAfterMs={phase.retryAfterMs} />;
  }
  if (phase.status === "rejected") {
    return <JoinRejected message={phase.message} />;
  }

  /* --- Loading ------------------------------------------------------------ */

  // `preview === undefined` is "still asking"; `null` is "no". They are
  // different answers and conflating them is how a slow connection turns into
  // a dead-link screen.
  if (authLoading || preview === undefined) return <JoinLoading />;

  if (preview === null) return <JoinRejected message={JOIN_REJECTED_MESSAGE} />;

  /* --- The party ---------------------------------------------------------- */

  const eventCard = <EventPreviewCard preview={preview} />;

  if (preview.kind === "past") {
    return (
      <div className="space-y-7">
        {eventCard}
        <Callout tone="info">
          This event has ended. You can’t join or add new photos, but the host may leave the
          finished gallery open here.
        </Callout>
        {preview.publicGalleryEnabled ? (
          <PastEventGallery token={token} />
        ) : (
          <div className="border-t border-line pt-5">
            <h2 className="text-base font-semibold text-ink">The photos are private</h2>
            <p className="mt-1 text-sm text-muted">
              The host hasn’t made this event’s approved photos available through the QR link.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        {eventCard}
        <OpenInApp token={token} />
        <GuestSignIn
          // Absolute, and on the canonical origin, so Google returns the guest
          // to the same invitation rather than to a preview deployment.
          callbackURL={joinUrl(token) ?? `/join/${token}`}
          onSignedIn={() => {
            // Nothing to do: `useConvexAuth` flips and the flow moves on.
          }}
        />
      </div>
    );
  }

  if (preview.alreadyMember) {
    return (
      <div className="space-y-6">
        {eventCard}
        <Callout tone="success">You're already in this event.</Callout>
        {showMobileAppDownloads ? (
          <div className="space-y-3">
            <OpenPartyBoothApp deepLink={mobileJoinUrl(token)} />
            <p className="text-center text-xs leading-relaxed text-faint">
              Don’t have PartyBooth yet? We’ll take you to the App Store.
            </p>
          </div>
        ) : null}
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          onClick={() => {
            router.replace(`/event/${preview.eventId}`);
          }}
        >
          Continue in browser
        </Button>
      </div>
    );
  }

  // The name field must not appear before the current name has arrived: an
  // empty field submits an empty name, and the guest has no idea why.
  if (me === undefined) return <JoinLoading />;

  return (
    <div className="space-y-6">
      {eventCard}

      <div className="border-t border-line pt-5">
        <p className="mb-4 text-sm text-muted">
          Last thing — check your name. It's what {preview.hostDisplayName} sees next to your
          photos.
        </p>
        <NameConfirmForm
          initialName={me?.displayName ?? ""}
          busy={busy}
          submitLabel="Join the party"
          onConfirmed={() => {
            void attemptJoin();
          }}
        />
      </div>

      {phase.status === "error" ? (
        <Callout tone="danger" live="assertive">
          {phase.message}
        </Callout>
      ) : null}
    </div>
  );
}
