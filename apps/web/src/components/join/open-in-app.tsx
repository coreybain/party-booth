import { ArrowRightIcon, LogoMark } from "@/components/icons";
import { mobileJoinUrl } from "@/lib/join-url";

/**
 * The installed app is the quickest path from a QR to the event. Store links
 * are deliberately absent until public listings exist; a download button that
 * lands on an unavailable product page is worse than the complete web path.
 */
export function OpenInApp({ token }: { readonly token: string }) {
  return (
    <section aria-label="Open in the PartyBooth app" className="space-y-3">
      <a
        href={mobileJoinUrl(token)}
        className="flex h-14 w-full items-center justify-between gap-3 rounded-xl bg-accent px-5 text-base font-semibold text-on-accent transition-[filter] hover:brightness-110 active:brightness-95"
      >
        <span className="inline-flex min-w-0 items-center gap-3">
          <LogoMark size={22} className="shrink-0" />
          <span className="truncate">Open this event in the app</span>
        </span>
        <ArrowRightIcon size={20} className="shrink-0" />
      </a>

      <p className="text-center text-xs leading-relaxed text-faint">
        Already have PartyBooth? It opens straight to this event. Otherwise, continue below in your
        browser.
      </p>

      <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-faint">
        <span className="h-px flex-1 bg-line" />
        continue in browser
        <span className="h-px flex-1 bg-line" />
      </div>
    </section>
  );
}
