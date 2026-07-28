"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * The console's four sections.
 *
 * Separate routes rather than tabs in one page, for a reason that matters at
 * 1 a.m.: an admin looking at a locked account and an admin reading the audit
 * log want to send each other a **link**, and a tab index in component state is
 * not a link. It also means the accounts scan and the audit scan never run at
 * the same time.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/accounts", label: "Accounts" },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/audit", label: "Audit log" },
];

/** `/admin` owns only itself; the others own their subtrees. */
export function isAdminNavItemActive(href: string, pathname: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
}

export function AdminNav({ className }: { readonly className?: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className={cn("flex justify-center", className)}>
      <ul className="flex items-center gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
        {ADMIN_NAV.map(({ href, label }) => {
          const active = isAdminNavItemActive(href, pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm transition-colors",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-raised hover:text-ink",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
