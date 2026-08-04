"use client";

import { useState } from "react";

import { Callout } from "@/components/ui/callout";
import { authClient } from "@/lib/auth-client";
import { isBackendConfigured } from "@/lib/backend";
import { cn } from "@/lib/cn";

export interface GoogleSignInButtonProps {
  /**
   * Where Google sends the guest back to. Must be an absolute URL on a trusted
   * origin — for the join flow this is the `/join/<token>` page itself, so the
   * guest lands back exactly where they were with the invite still in the URL.
   */
  readonly callbackURL: string;
  readonly className?: string;
  /** Reveals the email fallback when Google cannot start. */
  readonly onUnavailable?: () => void;
}

/**
 * "Continue with Google" — PLAN.md's primary web guest path.
 *
 * OTP is the fallback, not the other way round: at a party the phone is already
 * signed into Google, so this is one tap, while an emailed code is a trip to
 * another app on a bad connection.
 *
 * Whether Google is configured is a property of the **Convex** deployment
 * (`GOOGLE_CLIENT_ID` lives there, not in Vercel), so the button cannot know in
 * advance. It offers the option and turns a refusal into one sentence pointing
 * at the email path, rather than gating on an environment variable this app
 * does not own.
 *
 * `signIn.social` navigates the whole page away on success, so there is no
 * success branch to write — only the failure one.
 */
export function GoogleSignInButton({
  callbackURL,
  className,
  onUnavailable,
}: GoogleSignInButtonProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={!isBackendConfigured || pending}
        aria-busy={pending || undefined}
        onClick={() => {
          setPending(true);
          setFailed(false);
          void authClient.signIn
            .social({
              provider: "google",
              callbackURL,
              // Google bounces back here on cancel or misconfiguration; the
              // page re-renders signed-out and the guest can use email instead.
              errorCallbackURL: callbackURL,
            })
            .then((result) => {
              if (result.error) {
                setFailed(true);
                setPending(false);
                onUnavailable?.();
              }
            })
            .catch(() => {
              setFailed(true);
              setPending(false);
              onUnavailable?.();
            });
        }}
        className={cn(
          "flex h-12 w-full items-center justify-center gap-3 rounded-xl",
          "border border-line bg-raised text-base font-medium text-ink",
          "transition-colors hover:border-line-strong",
          "disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
      >
        <GoogleMark />
        {pending ? "Opening Google…" : "Continue with Google"}
      </button>

      {failed ? (
        <Callout tone="warning" live="polite">
          Google sign-in is not available right now. Try signing in with email instead.
        </Callout>
      ) : null}
    </div>
  );
}

/** Google's four-colour mark. Flat paths so it needs no external asset. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
