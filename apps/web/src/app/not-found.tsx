import Link from "next/link";

import { EventNotFoundActions } from "@/components/guest/event-not-found-actions";
import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";

export default function NotFound() {
  return (
    <CentredPane>
      <Card>
        <EventNotFoundActions />
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/host" className="underline underline-offset-2 hover:text-ink">
          Host sign in
        </Link>
      </p>
    </CentredPane>
  );
}
