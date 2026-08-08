import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ArrowRightIcon, QrIcon, UsersIcon } from "@/components/icons";
import { CentredPane } from "@/components/layout/centred-pane";
import { Card } from "@/components/layout/card";
import { PrivacyLink } from "@/components/layout/site-footer";
import { getOrganiserAccess, isServerBackendConfigured } from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Join or host an event",
};

/** The signed-in redirect below depends on the session cookie, so never cache. */
export const dynamic = "force-dynamic";

/** The public front door: guests join first, while hosts can reach their sign-in. */
export default async function HomePage() {
  const access = isServerBackendConfigured ? await getOrganiserAccess() : "signedOut";
  if (access === "ok") redirect("/dashboard");
  if (access !== "signedOut" && access !== "needsInvitation") redirect("/account/blocked");

  return (
    <CentredPane
      width="md"
      footer={
        <>
          Private beta · <PrivacyLink /> ·{" "}
          <Link href="/admin/login" className="underline underline-offset-2 hover:text-muted">
            Admin
          </Link>
        </>
      }
    >
      <Card>
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Welcome to PartyBooth</h1>
          <p className="mt-2 text-sm text-muted">
            Join the party or manage an event you&rsquo;re hosting.
          </p>
        </div>

        <div className="space-y-3">
          <Link
            href="/join"
            className="group flex items-center gap-4 rounded-2xl bg-accent p-4 text-on-accent transition-[filter] hover:brightness-110 active:brightness-95"
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/15">
              <QrIcon size={24} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Join an event</span>
              <span className="mt-0.5 block text-sm text-on-accent/80">
                Scan a QR code or enter the six-digit code.
              </span>
            </span>
            <ArrowRightIcon
              size={20}
              className="shrink-0 transition-transform group-hover:translate-x-0.5"
            />
          </Link>

          <Link
            href="/host"
            className="group flex items-center gap-4 rounded-2xl border border-line bg-raised p-4 text-ink transition-[border-color,background-color] hover:border-line-strong hover:bg-surface"
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-canvas text-muted">
              <UsersIcon size={24} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Log in as host</span>
              <span className="mt-0.5 block text-sm text-muted">
                Manage events, photos and the slideshow.
              </span>
            </span>
            <ArrowRightIcon
              size={20}
              className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        </div>
      </Card>
    </CentredPane>
  );
}
