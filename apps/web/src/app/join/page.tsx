import { mobileAppDownloadsEnabled } from "@partybooth/env/client";
import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { SiteFooter } from "@/components/layout/site-footer";
import { JoinPageContent } from "@/components/join/join-page-content";
import { PARTYBOOTH_APP_STORE_ID, PARTYBOOTH_APP_URL } from "@/lib/mobile-app";

export const metadata: Metadata = {
  title: "Join an event",
  ...(mobileAppDownloadsEnabled()
    ? { itunes: { appId: PARTYBOOTH_APP_STORE_ID, appArgument: PARTYBOOTH_APP_URL } }
    : {}),
  robots: { index: false, follow: false },
};

/**
 * QR-first join door, with six-digit entry for a guest whose camera cannot read
 * the printed sign.
 *
 * This is also the URL printed on the sign under the QR, because it is the only
 * one that is safe to print in full: it carries no credential, so a photograph
 * of the poster is not an invitation.
 */
export default function JoinPage() {
  return (
    <CentredPane width="md" footer={<SiteFooter note="Photos stay private to this event." />}>
      <Card>
        <JoinPageContent />
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
