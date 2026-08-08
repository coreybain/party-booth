import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { OrganiserInviteAcceptance } from "@/components/organiser-invite-acceptance";

export const metadata: Metadata = {
  title: "Accept host invitation",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function OrganiserInvitePage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;

  return (
    <CentredPane
      footer={
        <Link href="/" className="underline underline-offset-2 hover:text-muted">
          Back to PartyBooth
        </Link>
      }
    >
      <Card>
        <OrganiserInviteAcceptance token={token} />
      </Card>
    </CentredPane>
  );
}
