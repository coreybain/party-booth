import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CentredPane } from "@/components/layout/centred-pane";
import { Card } from "@/components/layout/card";
import { PrivacyLink } from "@/components/layout/site-footer";
import { OtpSignInForm } from "@/components/otp-sign-in-form";
import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { getOrganiserAccess, isServerBackendConfigured } from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Host sign in",
};

/** The signed-in redirect below depends on the session cookie, so never cache. */
export const dynamic = "force-dynamic";

/** Organiser email-OTP sign-in, kept separate from the public choice at `/`. */
export default async function HostSignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly needs?: string }>;
}) {
  const access = isServerBackendConfigured ? await getOrganiserAccess() : "signedOut";
  if (access === "ok") redirect("/dashboard");
  if (access !== "signedOut" && access !== "needsInvitation") redirect("/account/blocked");

  const { needs } = await searchParams;
  const uninvited = access === "needsInvitation";

  return (
    <CentredPane
      footer={
        <>
          Private beta · <PrivacyLink /> ·{" "}
          <Link href="/admin/login" className="underline underline-offset-2 hover:text-muted">
            Admin
          </Link>
        </>
      }
    >
      <Card>
        {uninvited ? (
          <>
            <h1 className="text-lg font-semibold tracking-tight text-ink">
              You&rsquo;re signed in, but not invited yet
            </h1>
            <p className="mt-1 text-sm text-muted">
              PartyBooth is invitation-only while it is in private beta. Hosting needs an organiser
              invitation, which arrives by email; co-hosting needs a host to invite this address.
            </p>
            <Callout tone="info" className="mt-4">
              Already been invited? The invitation binds to the exact address it was sent to. Sign
              out and sign in again with that one.
            </Callout>
            <div className="mt-5 space-y-2">
              <Link href="/join" className="block">
                <Button size="lg" fullWidth>
                  Join an event with a code
                </Button>
              </Link>
              <SignOutButton redirectTo="/" />
            </div>
          </>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-lg font-semibold tracking-tight text-ink">Log in as host</h1>
              <p className="mt-1 text-sm text-muted">
                Host an event, moderate submissions and run the slideshow.
              </p>
            </div>
            {needs === "invitation" ? (
              <Callout tone="info" className="mb-4">
                That console needs an organiser invitation. Sign in with the address it was sent to.
              </Callout>
            ) : null}
            <OtpSignInForm audience="organiser" redirectTo="/dashboard" />
          </>
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        Joining someone else&rsquo;s event?{" "}
        <Link href="/join" className="text-accent underline underline-offset-2">
          Scan or enter a code
        </Link>
      </p>
    </CentredPane>
  );
}
