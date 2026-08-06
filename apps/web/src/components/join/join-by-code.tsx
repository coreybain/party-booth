"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { BackendGate } from "@/components/backend-gate";
import { GuestSignIn } from "@/components/guest/guest-sign-in";
import { NameConfirmForm } from "@/components/guest/name-confirm-form";
import { EventPreviewCard } from "@/components/join/event-preview-card";
import { JoinCodeForm } from "@/components/join-code-form";
import { JoinLoading, JoinRejected, JoinThrottled } from "@/components/join/join-states";
import { OpenPartyBoothApp } from "@/components/join/open-partybooth-app";
import { StoreBadges } from "@/components/join/store-badges";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type JoinPreview } from "@/lib/convex-api";
import { JOIN_REJECTED_MESSAGE } from "@/lib/contracts";
import { joinFallbackUrl, mobileJoinUrl } from "@/lib/join-url";
import { requestPreviewByCode } from "@/lib/join-transport";
import { useJoinAttempt } from "@/lib/use-join";

/**
 * Joining by typing the six digits from the sign.
 *
 * Sign-in comes **first** here, and after the code on the QR path. That is not
 * an inconsistency, it is the enumeration rule showing through: resolving a
 * six-digit code is only safe from an authenticated, throttled mutation
 * (`previewByCode`), because six digits is a million values and an open
 * "is this real?" endpoint is the oracle the whole design denies. A 160-bit
 * token has no such problem, so that path can show the party first.
 *
 * The consequence for the guest is one extra step, and the copy says why in one
 * line rather than leaving them wondering.
 *
 * The join call itself is `useJoinAttempt`, shared with the QR path, so the two
 * front doors cannot drift into saying different things about the same refusal.
 * What is local to this component is the lookup that happens *before* it.
 */
export function JoinByCode() {
  return (
    <BackendGate>
      <JoinByCodeLive />
    </BackendGate>
  );
}

function JoinByCodeLive() {
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();

  const me = useQuery(backendApi.users.currentUser, isAuthenticated ? {} : "skip");
  const { phase, busy, attempt, reset } = useJoinAttempt();

  const [code, setCode] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<JoinPreview | undefined>(undefined);
  /** The lookup half only. Everything after the join is `phase`. */
  const [lookup, setLookup] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "rejected" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const lookUp = useCallback(async (entered: string) => {
    setLookup({ kind: "checking" });
    setCode(entered);
    try {
      // Through `/api/join`, not the Convex socket: the lookup is the call a
      // code-walker actually makes, so it is the one that most needs the
      // server-derived network key on its throttle. See `join-transport.ts`.
      const found = await requestPreviewByCode(entered);
      if (found === null) {
        // One answer for "no such code", "old code" and "not open yet".
        setLookup({ kind: "rejected" });
        return;
      }
      setPreview(found);
      setLookup({ kind: "idle" });
    } catch (error) {
      setLookup({ kind: "error", message: appErrorMessage(error) });
    }
  }, []);

  const attemptJoin = useCallback(async () => {
    if (code === undefined) return;
    await attempt({ via: "code", code });
  }, [attempt, code]);

  const startOver = useCallback(() => {
    setPreview(undefined);
    setCode(undefined);
    setLookup({ kind: "idle" });
    reset();
  }, [reset]);

  if (phase.status === "throttled") {
    return <JoinThrottled message={phase.message} retryAfterMs={phase.retryAfterMs} />;
  }
  // A refused lookup and a refused join are the same screen wearing the same
  // sentence, on purpose: a guest must not be able to tell "that code is not a
  // code" from "that code is not yours".
  if (lookup.kind === "rejected" || phase.status === "rejected") {
    return (
      <div className="space-y-6">
        <JoinRejected
          message={phase.status === "rejected" ? phase.message : JOIN_REJECTED_MESSAGE}
          showCodeEntry={false}
        />
        <Button variant="secondary" size="lg" fullWidth onClick={startOver}>
          Try another code
        </Button>
      </div>
    );
  }

  if (authLoading) return <JoinLoading />;

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Join an event</h1>
          <p className="mt-1 text-sm text-muted">
            Sign in first, then enter the six-digit code. We ask in this order so nobody can sit and
            guess codes.
          </p>
        </div>
        <GuestSignIn
          callbackURL={joinFallbackUrl() ?? "/join"}
          onSignedIn={() => {
            // The code form appears as soon as `useConvexAuth` flips.
          }}
        />
        <StoreBadges />
      </div>
    );
  }

  if (preview === undefined) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Enter the event code</h1>
          <p className="mt-1 text-sm text-muted">
            Six digits, printed under the QR code on the sign.
          </p>
        </div>
        <JoinCodeForm
          onSubmit={(entered) => {
            void lookUp(entered);
          }}
          pending={lookup.kind === "checking"}
          {...(lookup.kind === "error" ? { error: lookup.message } : {})}
        />
        <StoreBadges />
      </div>
    );
  }

  // A preview can only be produced by a completed lookup, which also records
  // the code. Keep that invariant explicit before building the native route.
  if (code === undefined) return <JoinLoading />;

  if (preview.alreadyMember) {
    return (
      <div className="space-y-6">
        <EventPreviewCard preview={preview} />
        <Callout tone="success">You're already in this event.</Callout>
        <div className="space-y-3">
          <OpenPartyBoothApp deepLink={mobileJoinUrl(code)} />
          <p className="text-center text-xs leading-relaxed text-faint">
            Don’t have PartyBooth yet? We’ll take you to the App Store.
          </p>
        </div>
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

  // Wait for the profile before offering the name field: an empty field
  // submits an empty name and the guest has no idea why. `null` is different —
  // it means the mirrored row is genuinely missing, and typing a name is then
  // the only way forward.
  if (me === undefined) return <JoinLoading />;

  return (
    <div className="space-y-6">
      <EventPreviewCard preview={preview} />

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
