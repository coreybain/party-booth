import { mobileAppDownloadsEnabled } from "@partybooth/env/client";

import { OpenPartyBoothApp } from "@/components/join/open-partybooth-app";
import { mobileJoinUrl } from "@/lib/join-url";

/**
 * The installed app is the quickest path from a QR to the event. If iOS cannot
 * open the registered scheme, the shared control falls through to the App
 * Store while this page remains the complete browser path.
 */
export function OpenInApp({
  token,
  enabled = mobileAppDownloadsEnabled(),
}: {
  readonly token: string;
  readonly enabled?: boolean;
}) {
  if (!enabled) return null;

  return (
    <section aria-label="Open in the PartyBooth app" className="space-y-3">
      <OpenPartyBoothApp
        deepLink={mobileJoinUrl(token)}
        label="Open this event in the app"
        enabled={enabled}
      />

      <p className="text-center text-xs leading-relaxed text-faint">
        It opens straight to this event if PartyBooth is installed. Otherwise, you’ll be taken to
        the App Store — or you can continue below in your browser.
      </p>

      <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-faint">
        <span className="h-px flex-1 bg-line" />
        continue in browser
        <span className="h-px flex-1 bg-line" />
      </div>
    </section>
  );
}
