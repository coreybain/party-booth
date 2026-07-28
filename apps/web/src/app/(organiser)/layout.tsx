import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PreviewModeBanner } from "@/components/backend-not-configured";
import { AppShell } from "@/components/layout/app-shell";
import { EventSwitcher } from "@/components/layout/event-switcher";
import { OrganiserNav } from "@/components/layout/organiser-nav";
import { PartyBoothWordmark } from "@/components/layout/centred-pane";
import { SignOutButton } from "@/components/sign-out-button";
import { getOrganiserAccess, isServerBackendConfigured } from "@/lib/auth-server";

/**
 * The authenticated organiser shell.
 *
 * One gate with four answers rather than two booleans, because "not allowed in"
 * has four different causes and each of them needs a different destination —
 * `getOrganiserAccess` in `src/lib/auth-server.ts` explains why, and
 * `organiserAccess` in `src/lib/lock-view.ts` is the tested decision behind it.
 * In short:
 *
 * - **signed out** → `/`, the sign-in page.
 * - **locked / being deleted** → `/account/blocked`, which says so. This used to
 *   land on `/?needs=invitation`, which was both untrue and — since `/` bounces
 *   a signed-in visitor to `/dashboard` — an infinite redirect.
 * - **no invitation** → `/?needs=invitation`. PLAN.md makes the private beta
 *   invitation-only, so a valid Better Auth session is authentication and
 *   `users.isOrganiser` or the admin allowlist is authorisation.
 * - **hosts something** → in. A co-host is not an organiser (accepting a
 *   co-host invitation deliberately does not set `isOrganiser`) and must still
 *   be able to reach `/media` — that is the whole of RC5.
 *
 * The one exception is **preview mode** — when no Convex deployment is
 * configured there is no session to check and no data to protect, so the shell
 * renders with a banner instead of bouncing to a login page that also cannot
 * work. As soon as `CONVEX_URL` is set the gate is live and fails closed (every
 * helper returns the refusing answer on any error).
 */

/**
 * Never prerender an authenticated shell. `isAuthenticated()` already forces
 * dynamic rendering by reading the session cookie, but stating it here means a
 * future refactor cannot accidentally bake a signed-in page into the CDN.
 */
export const dynamic = "force-dynamic";
export default async function OrganiserLayout({ children }: { readonly children: ReactNode }) {
  const previewMode = !isServerBackendConfigured;

  if (!previewMode) {
    const access = await getOrganiserAccess();
    if (access === "signedOut") redirect("/");
    if (access === "needsInvitation") redirect("/?needs=invitation");
    if (access !== "ok") redirect("/account/blocked");
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
