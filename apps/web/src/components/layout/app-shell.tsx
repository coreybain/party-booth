import type { ReactNode } from "react";

import { PrivacyLink } from "@/components/layout/site-footer";
import { cn } from "@/lib/cn";

export interface AppShellProps {
  /**
   * Re-themes the whole subtree via the CSS variables in `globals.css`.
   * `admin` is deliberately a different palette — PLAN.md → "Distinct /admin
   * shell". Omit for the organiser console.
   */
  readonly shell?: "admin";
  /** Left of the header: wordmark, usually wrapped in a `<Link href="/">`. */
  readonly brand: ReactNode;
  /** Centre of the header: the event switcher on the organiser side. */
  readonly headerCentre?: ReactNode;
  /** Right of the header: account actions. */
  readonly headerRight?: ReactNode;
  /** The centred icon nav, rendered on its own row under the header. */
  readonly nav?: ReactNode;
  /** Full-bleed strip above the header (preview mode, incidents, lock notices). */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}

/**
 * The generic authenticated shell: sticky header, optional centred nav row,
 * constrained content column.
 *
 * Both the organiser console and the global-admin console use it — they differ
 * only in palette (`shell`) and in what they pass into the slots. Keeping the
 * chrome in one component is what makes it cheap to add the guest experience
 * later without a third layout.
 */
export function AppShell({
  shell,
  brand,
  headerCentre,
  headerRight,
  nav,
  banner,
  children,
}: AppShellProps) {
  return (
    <div data-shell={shell} className="flex min-h-dvh flex-col bg-canvas text-ink">
      {banner}

      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
          <div className="flex shrink-0 items-center">{brand}</div>
          <div className="flex min-w-0 flex-1 justify-center">{headerCentre}</div>
          <div className="flex shrink-0 items-center justify-end">{headerRight}</div>
        </div>
        {nav ? <div className="mx-auto w-full max-w-5xl px-4 pb-3">{nav}</div> : null}
      </header>

      <main
        className={cn(
          "mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8",
          // Clear the home indicator on iOS when the page is short.
          "pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        )}
      >
        {children}
      </main>

      {/*
        One line, always present. The privacy policy has to be reachable from
        every signed-in screen as well as every signed-out one — App Review
        checks that a person can find it, not merely that the URL resolves.
      */}
      <footer className="border-t border-line px-4 py-4 text-center text-xs text-faint">
        PartyBooth · <PrivacyLink />
      </footer>
    </div>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
