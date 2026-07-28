import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { SiteFooter } from "@/components/layout/site-footer";
import { JoinByToken } from "@/components/join/join-by-token";
import { JoinRejected } from "@/components/join/join-states";
import { isValidInviteToken, JOIN_REJECTED_MESSAGE, normalizeInviteToken } from "@/lib/contracts";

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
 * This URL is what the printed signage encodes and what the iOS and Android
 * apps claim as an app link. Opening it on a phone with the app installed hands
 * off to the app; otherwise the guest continues here on mobile web, which
 * PLAN.md makes the *guaranteed* path for 5 August.
 *
 * The token is never **displayed** — this page gets screenshotted and shared.
 * It still travels in the URL and therefore in the RSC payload, which is
 * unavoidable, and is why the page is `noindex` + `no-referrer` and why
 * `sentry-scrub.ts` strips `/join/<token>` out of every event.
 *
 * The shape check below is not a security decision: a malformed token and a
 * revoked one produce the same screen and the same sentence. It only saves a
 * round trip on a link a messaging app has plainly mangled.
 */
export default async function JoinByTokenPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  // Crockford base32 folds the transcription errors people make; normalising
  // here means a link typed by hand resolves to the same string the QR encodes.
  const normalised = normalizeInviteToken(token);

  return (
    <CentredPane width="md" footer={<SiteFooter note="Photos stay private to this event." />}>
      <Card>
        {isValidInviteToken(normalised) ? (
          <JoinByToken token={normalised} />
        ) : (
          <JoinRejected message={JOIN_REJECTED_MESSAGE} />
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        Hosting instead?{" "}
        <Link href="/" className="text-accent underline underline-offset-2">
          Organiser sign in
        </Link>
      </p>
    </CentredPane>
  );
}
