"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

import { HomeIcon, MediaIcon, SettingsIcon, SlideshowIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  /** Extra path prefixes this tab owns, beyond `href` itself. */
  readonly owns?: readonly string[];
}

/**
 * The organiser console's four destinations (PLAN.md → "Organiser website").
 * Sprint 1 ships the shell; each page fills in over Sprints 2–5.
 *
 * "Home" also owns `/events/*`: an event's own page is reached *from* the list,
 * and leaving every tab unlit while a host looks at their event reads as a
 * broken nav rather than as a different section.
 */
export const ORGANISER_NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Home", Icon: HomeIcon, owns: ["/events"] },
  { href: "/slideshow", label: "Slideshow", Icon: SlideshowIcon },
  { href: "/media", label: "Moderate", Icon: MediaIcon },
  { href: "/settings", label: "Settings", Icon: SettingsIcon },
];

/** Does this tab own the current path? */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.owns ?? [])].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * A small centred pill of icon buttons.
 *
 * Icon-only with an accessible name, because the organiser uses this one-handed
 * on a phone while moderating during a party — four labelled tabs would not fit
 * next to the event switcher on a 375 px screen. The label appears on hover and
 * on wider screens.
 */
export function OrganiserNav({ className }: { readonly className?: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Organiser sections" className={cn("flex justify-center", className)}>
      <ul className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
        {ORGANISER_NAV.map((item) => {
          const { href, label, Icon } = item;
          const active = isNavItemActive(item, pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={label}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-full px-3.5 text-sm transition-colors",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-raised hover:text-ink",
                )}
              >
                <Icon size={18} />
                <span className={cn("hidden sm:inline", !active && "sm:hidden md:inline")}>
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
