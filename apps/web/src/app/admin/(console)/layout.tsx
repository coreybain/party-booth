import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PreviewModeBanner } from "@/components/backend-not-configured";
import { AppShell } from "@/components/layout/app-shell";
import { ShieldIcon } from "@/components/icons";
import { SignOutButton } from "@/components/sign-out-button";
import { AdminNav } from "@/components/admin/admin-nav";
import { getAdminAccess, isServerBackendConfigured } from "@/lib/auth-server";

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
 *
 * A staff account that has been **locked** is the one case that is neither: it
 * is on the list and it is not allowed in, and showing it a 404 about a console
 * it built helps nobody. It goes to `/account/blocked`, same as an organiser.
 */

/** Never prerender the admin shell. See the organiser layout for the rationale. */
export const dynamic = "force-dynamic";
export default async function AdminConsoleLayout({ children }: { readonly children: ReactNode }) {
  const previewMode = !isServerBackendConfigured;

  if (!previewMode) {
    const access = await getAdminAccess();
    if (access === "signedOut") redirect("/admin/login");
    if (access === "needsInvitation") notFound();
    if (access !== "ok") redirect("/account/blocked");
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
      headerRight={<SignOutButton redirectTo="/admin/login" />}
      nav={<AdminNav />}
    >
      {children}
    </AppShell>
  );
}
