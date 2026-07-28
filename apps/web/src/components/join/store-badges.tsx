import { cn } from "@/lib/cn";

/**
 * Where the App Store and Play links go.
 *
 * They are placeholders on purpose, not an oversight: PLAN.md accepts that
 * neither store listing may exist on 5 August (App Review, and Play's 14-day
 * closed-testing rule), and makes mobile web the *guaranteed* path. So this
 * block says the web experience is complete rather than implying the guest is
 * missing out, and the copy needs no edit if the builds never land in time —
 * only the two `href`s do.
 */
export function StoreBadges({ className }: { readonly className?: string }) {
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
