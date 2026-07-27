import Link from "next/link";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";

export default function NotFound() {
  return (
    <CentredPane>
      <Card>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Nothing here</h1>
        <p className="mt-1 text-sm text-muted">
          That link may have expired, or the host may have rotated the event code.
        </p>
        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <Link href="/join" className="text-accent underline underline-offset-2">
            Join with a code
          </Link>
          <Link href="/" className="text-muted underline underline-offset-2 hover:text-ink">
            Organiser sign in
          </Link>
        </div>
      </Card>
    </CentredPane>
  );
}
