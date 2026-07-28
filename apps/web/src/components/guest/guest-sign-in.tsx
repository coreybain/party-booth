"use client";

import { GoogleSignInButton } from "@/components/guest/google-sign-in-button";
import { OtpSignInForm } from "@/components/otp-sign-in-form";

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
  return (
    <div className="space-y-5">
      <GoogleSignInButton callbackURL={callbackURL} />

      <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-faint">
        <span className="h-px flex-1 bg-line" />
        or use your email
        <span className="h-px flex-1 bg-line" />
      </div>

      <OtpSignInForm audience="guest" onSignedIn={onSignedIn} />

      <p className="text-xs leading-relaxed text-faint">
        Signing in tells the host who took which photo, and lets you take yours back down. Private
        beta, 18+.
      </p>
    </div>
  );
}
