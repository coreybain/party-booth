import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { JoinByCode } from "@/components/join/join-by-code";

export const metadata: Metadata = {
  title: "Join an event",
  robots: { index: false, follow: false },
};

/**
 * Code-entry fallback, for a guest who types the six digits from the printed
 * signage instead of scanning the QR (TODO.md Sprint 2 → "code entry fallback
 * with store links").
 *
 * This is also the URL printed on the sign under the QR, because it is the only
 * one that is safe to print in full: it carries no credential, so a photograph
 * of the poster is not an invitation.
 */
export default function JoinPage() {
  return (
    <CentredPane width="md" footer="Private beta · 18+ · Photos stay private to this event.">
      <Card>
        <JoinByCode />
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
