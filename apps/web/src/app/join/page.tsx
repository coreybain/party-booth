import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { JoinCodeForm } from "@/components/join-code-form";
import { QrIcon } from "@/components/icons";

export const metadata: Metadata = { title: "Join an event" };

/**
 * Code-entry entry point, for guests who type the six digits from the printed
 * signage instead of scanning the QR (TODO.md Sprint 2 → "code entry fallback").
 */
export default function JoinPage() {
  return (
    <CentredPane footer="You'll be asked to sign in before you can add photos.">
      <Card>
        <div className="mb-6 flex items-start gap-3">
          <QrIcon size={22} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Join an event</h1>
            <p className="mt-1 text-sm text-muted">
              Enter the six-digit code from the sign, or scan its QR code.
            </p>
          </div>
        </div>
        <JoinCodeForm />
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
