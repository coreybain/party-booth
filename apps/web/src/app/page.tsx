import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CentredPane } from "@/components/layout/centred-pane";
import { Card } from "@/components/layout/card";
import { PrivacyLink } from "@/components/layout/site-footer";
import { OtpSignInForm } from "@/components/otp-sign-in-form";
import { isAuthenticated } from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Sign in",
};

/** The signed-in redirect below depends on the session cookie, so never cache. */
export const dynamic = "force-dynamic";

/**
 * Organiser sign-in — the site root.
 *
 * PLAN.md gives organisers exactly one way in on the web: a six-digit email
 * OTP. Google sign-in arrives in Sprint 2 for *guests*; Apple is app-only.
 */
export default async function SignInPage() {
  if (await isAuthenticated()) redirect("/dashboard");

  return (
    <CentredPane
      footer={
        <>
          Private beta · 18+ · <PrivacyLink /> ·{" "}
          <Link href="/admin/login" className="underline underline-offset-2 hover:text-muted">
            Admin
          </Link>
        </>
      }
    >
      <Card>
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            Host an event, moderate submissions and run the slideshow.
          </p>
        </div>
        <OtpSignInForm audience="organiser" redirectTo="/dashboard" />
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        Been sent a QR code or a six-digit code?{" "}
        <Link href="/join" className="text-accent underline underline-offset-2">
          Join an event
        </Link>
      </p>
    </CentredPane>
  );
}
