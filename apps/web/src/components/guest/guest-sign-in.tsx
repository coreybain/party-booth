"use client";

import { useId, useState } from "react";

import { GoogleSignInButton } from "@/components/guest/google-sign-in-button";
import { OtpSignInForm } from "@/components/otp-sign-in-form";
import { Button } from "@/components/ui/button";

export interface GuestSignInProps {
  /** Absolute URL Google returns to. Usually the page the guest is standing on. */
  readonly callbackURL: string;
  /** Called after an OTP sign-in, which stays on the page. */
  readonly onSignedIn: () => void;
}

/**
 * Guest sign-in: Google, or a six-digit email code.
 *
 * PLAN.md → "Guests on web: Google sign-in or email OTP (no Apple web OAuth)".
 * Deliberately minimal — no marketing, no account creation language, no
 * password anywhere. A guest at a party is standing up, holding a drink, on
 * somebody else's Wi-Fi; every extra field is a person who does not join.
 *
 * Both paths land on the same account, because Better Auth links accounts on a
 * provider-verified address — so a guest who used Google tonight and an emailed
 * code next month is still one person with one set of photos.
 */
export function GuestSignIn({ callbackURL, onSignedIn }: GuestSignInProps) {
  const [showEmail, setShowEmail] = useState(false);
  const emailRegionId = useId();

  return (
    <div className="space-y-4">
      <GoogleSignInButton
        callbackURL={callbackURL}
        onUnavailable={() => {
          setShowEmail(true);
        }}
      />

      {showEmail ? (
        <div id={emailRegionId} className="space-y-5 border-t border-line pt-5">
          <p className="text-center text-xs uppercase tracking-widest text-faint">
            Sign in with email
          </p>
          <OtpSignInForm audience="guest" onSignedIn={onSignedIn} />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="md"
          fullWidth
          aria-expanded={false}
          aria-controls={emailRegionId}
          onClick={() => {
            setShowEmail(true);
          }}
        >
          Use email instead
        </Button>
      )}

      <p className="text-xs leading-relaxed text-faint">
        Signing in tells the host who took which photo, and lets you take yours back down. Private
        beta, 18+.
      </p>
    </div>
  );
}
