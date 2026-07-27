import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PreviewModeBanner } from "@/components/backend-not-configured";
import { AppShell } from "@/components/layout/app-shell";
import { ShieldIcon } from "@/components/icons";
import { SignOutButton } from "@/components/sign-out-button";
import { isAuthenticated, isServerBackendConfigured } from "@/lib/auth-server";

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
 * TODO(Sprint 5): being signed in is necessary but not sufficient — the
 * `ADMIN_EMAIL_ALLOWLIST` check happens in Convex and must be re-asserted here
 * before any admin data is fetched.
 */

/** Never prerender the admin shell. See the organiser layout for the rationale. */
export const dynamic = "force-dynamic";
export default async function AdminConsoleLayout({ children }: { readonly children: ReactNode }) {
  const previewMode = !isServerBackendConfigured;

  if (!previewMode && !(await isAuthenticated())) {
    redirect("/admin/login");
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
