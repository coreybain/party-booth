import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/layout/card";
import { CentredPane } from "@/components/layout/centred-pane";
import { OtpSignInForm } from "@/components/otp-sign-in-form";
import { ShieldIcon } from "@/components/icons";
import { isAuthenticated } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Admin sign in" };

/**
 * Global-admin sign in — a separate route from the organiser login on purpose
 * (PLAN.md → "Global admins: separate /admin OTP login with server-side
 * allowlist").
 *
 * The allowlist itself lives in `ADMIN_EMAIL_ALLOWLIST` and is enforced in
 * Convex before an OTP is ever sent, so this page must never disclose whether
 * an address is on it. Same form, same failure messages as the organiser login.
 */

/** The signed-in redirect below depends on the session cookie, so never cache. */
export const dynamic = "force-dynamic";
export default async function AdminLoginPage() {
  if (await isAuthenticated()) redirect("/admin");

  return (
    <div data-shell="admin" className="min-h-dvh bg-canvas text-ink">
      <CentredPane
        brand={
          <span className="inline-flex items-center gap-2">
            <ShieldIcon size={22} className="text-accent" />
            <span className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">
              PartyBooth Admin
            </span>
          </span>
        }
        footer={
          <Link href="/" className="underline underline-offset-2 hover:text-muted">
            Back to PartyBooth
          </Link>
        }
      >
        <Card>
          <div className="mb-6">
            <h1 className="text-lg font-semibold tracking-tight text-ink">Staff sign in</h1>
            <p className="mt-1 text-sm text-muted">
              Every action in the admin console is logged against your account with a reason.
            </p>
          </div>
          <OtpSignInForm audience="admin" redirectTo="/admin" />
        </Card>
      </CentredPane>
    </div>
  );
}
