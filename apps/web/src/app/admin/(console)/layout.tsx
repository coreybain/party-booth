import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PreviewModeBanner } from "@/components/backend-not-configured";
import { AppShell } from "@/components/layout/app-shell";
import { ShieldIcon } from "@/components/icons";
import { SignOutButton } from "@/components/sign-out-button";
import {
  isAuthenticated,
  isGlobalAdminAuthorised,
  isServerBackendConfigured,
} from "@/lib/auth-server";

/**
 * The authenticated global-admin shell.
 *
 * `shell="admin"` swaps the palette (see `globals.css`) so this console never
 * looks like an organiser's own event — PLAN.md calls for a "distinct /admin
 * shell", and the whole point is that a destructive action here is obviously
 * happening in staff tooling.
 *
 * Same preview-mode carve-out as the organiser shell: with no Convex
 * deployment there is no session and no data, so the shell renders behind a
 * banner. With a deployment configured the gate fails closed.
 *
 * **Being signed in is necessary but not sufficient.** The `emailOTP` plugin
 * has no `disableSignUp`, so any address on earth can request a code at
 * `/admin/login` and end up with a valid session — the allowlist is what makes
 * this staff tooling, and it is asserted here before anything renders. It is
 * defence in depth, not the boundary: every Convex query and mutation the
 * console gains from Sprint 5 must call `requireGlobalAdmin` itself.
 *
 * A non-admin gets `notFound()` rather than a redirect. A bounce to
 * `/admin/login` from a page they are already signed in for confirms that the
 * console exists and that they are simply not on the list; a 404 says nothing.
 */

/** Never prerender the admin shell. See the organiser layout for the rationale. */
export const dynamic = "force-dynamic";
export default async function AdminConsoleLayout({ children }: { readonly children: ReactNode }) {
  const previewMode = !isServerBackendConfigured;

  if (!previewMode) {
    if (!(await isAuthenticated())) redirect("/admin/login");
    if (!(await isGlobalAdminAuthorised())) notFound();
  }

  return (
    <AppShell
      shell="admin"
      banner={previewMode ? <PreviewModeBanner /> : null}
      brand={
        <Link href="/admin" className="inline-flex items-center gap-2" aria-label="Admin console">
          <ShieldIcon size={20} className="text-accent" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Admin
          </span>
        </Link>
      }
      headerCentre={
        // Hidden on the narrowest screens: at 390 px it wraps and squeezes the
        // wordmark. The palette and the ADMIN wordmark already carry the
        // "you are in staff tooling" signal on their own.
        <span className="hidden rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-xs font-medium text-accent sm:inline-block">
          Staff tooling — every action is audited
        </span>
      }
      headerRight={<SignOutButton redirectTo="/admin/login" />}
    >
      {children}
    </AppShell>
  );
}
