import { mobileAppDownloadsEnabled } from "@partybooth/env/client";

import { cn } from "@/lib/cn";

/**
 * Where the App Store and Play links go.
 *
 * This whole block is hidden unless `NEXT_PUBLIC_MOBILE_APP_DOWNLOADS_ENABLED=1`.
 * The disabled-by-default gate is deliberate: PLAN.md accepts that
 * neither store listing may exist on 5 August (App Review, and Play's 14-day
 * closed-testing rule), and makes mobile web the *guaranteed* path. So this
 * block must not imply the guest is missing out while either app is unavailable.
 */
export function StoreBadges({
  className,
  enabled = mobileAppDownloadsEnabled(),
}: {
  readonly className?: string;
  /** Explicit override for isolated rendering/tests; production uses the public environment flag. */
  readonly enabled?: boolean;
}) {
  if (!enabled) return null;

  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-line px-4 py-3 text-center text-sm",
        className,
      )}
    >
      <p className="text-ink">Everything works right here in your browser.</p>
      <p className="mt-1 text-faint">
        Apps for iPhone and Android are on the way — links will appear here once they are approved.
      </p>
    </div>
  );
}
