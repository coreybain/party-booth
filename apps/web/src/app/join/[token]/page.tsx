import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { JoinCodeForm } from "@/components/join-code-form";
import { QrIcon } from "@/components/icons";
import { Callout } from "@/components/ui/callout";
import { isValidInviteToken } from "@/lib/contracts";

export const metadata: Metadata = {
  title: "Join an event",
  // The token is a bearer credential; keep it out of search engines and out of
  // any referrer sent to a third party.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * The QR / universal-link target: `https://<site>/join/<token>`.
 *
 * This URL is what the printed signage encodes, and what the iOS and Android
 * apps claim as an app link. Opening it on a phone with the app installed hands
 * off to the app; otherwise the guest continues here on mobile web, which
 * PLAN.md makes the *guaranteed* path for 5 August.
 *
 * Sprint 1 is the shell only. The token is deliberately never *displayed*: it is
 * a bearer credential and this page will be screenshotted and shared. (It still
 * travels in the URL and therefore in the RSC payload — unavoidable — which is
 * why the page is `noindex` + `no-referrer`, and why `sentry-scrub.ts` strips
 * `/join/<token>` from every event.)
 *
 * TODO(Sprint 2): resolve the token in Convex (authenticated,
 * rate-limited, enumeration-protected, audited) and branch on the result. An
 * unknown, revoked or superseded token must be indistinguishable from a valid
 * one to an unauthenticated caller.
 */
export default async function JoinByTokenPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  // Shape check only — `isValidInviteToken` says "this could be one of ours",
  // never "this one exists". Resolution happens in Convex in Sprint 2.
  const looksLikeToken = isValidInviteToken(token);

  return (
    <CentredPane width="md" footer="You'll be asked to sign in before you can add photos.">
      <Card>
        <div className="mb-6 flex items-start gap-3">
          <QrIcon size={22} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">You're invited</h1>
            <p className="mt-1 text-sm text-muted">
              {looksLikeToken
                ? "This link carries an event invitation."
                : "This link doesn't look like a valid invitation."}
            </p>
          </div>
        </div>

        <Callout tone="info">
          Invitation links aren't resolved yet — that lands in Sprint 2 along with guest sign-in.
          Until then, use the six-digit code from the sign.
        </Callout>

        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-faint">
          <span className="h-px flex-1 bg-line" />
          or enter the code
          <span className="h-px flex-1 bg-line" />
        </div>

        <JoinCodeForm />
      </Card>

      <div className="mt-6 rounded-2xl border border-dashed border-line px-4 py-3 text-center text-sm text-muted">
        <p className="text-ink">Prefer the app?</p>
        <p className="mt-1 text-faint">
          App Store and Play internal-testing links appear here once the builds are approved (Sprint
          4). The web experience is complete on its own.
        </p>
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        Hosting instead?{" "}
        <Link href="/" className="text-accent underline underline-offset-2">
          Organiser sign in
        </Link>
      </p>
    </CentredPane>
  );
}
