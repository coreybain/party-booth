import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PreviewModeBanner } from "@/components/backend-not-configured";
import { AppShell } from "@/components/layout/app-shell";
import { EventSwitcher } from "@/components/layout/event-switcher";
import { OrganiserNav } from "@/components/layout/organiser-nav";
import { PartyBoothWordmark } from "@/components/layout/centred-pane";
import { SignOutButton } from "@/components/sign-out-button";
import { isAuthenticated, isServerBackendConfigured } from "@/lib/auth-server";

/**
 * The authenticated organiser shell.
 *
 * Auth gate: signed out → back to `/`. The one exception is **preview mode** —
 * when no Convex deployment is configured there is no session to check and no
 * data to protect, so the shell renders with a banner instead of bouncing to a
 * login page that also cannot work. As soon as `CONVEX_URL` is set the gate is
 * live and fails closed (`isAuthenticated()` returns `false` on any error).
 */

/**
 * Never prerender an authenticated shell. `isAuthenticated()` already forces
 * dynamic rendering by reading the session cookie, but stating it here means a
 * future refactor cannot accidentally bake a signed-in page into the CDN.
 */
export const dynamic = "force-dynamic";
export default async function OrganiserLayout({ children }: { readonly children: ReactNode }) {
  const previewMode = !isServerBackendConfigured;

  if (!previewMode && !(await isAuthenticated())) {
    redirect("/");
  }

  return (
    <AppShell
      banner={previewMode ? <PreviewModeBanner /> : null}
      brand={
        <Link href="/dashboard" aria-label="PartyBooth home">
          <PartyBoothWordmark className="text-base" />
        </Link>
      }
      headerCentre={<EventSwitcher />}
      headerRight={<SignOutButton redirectTo="/" />}
      nav={<OrganiserNav />}
    >
      {children}
    </AppShell>
  );
}
