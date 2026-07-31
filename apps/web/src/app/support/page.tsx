import type { Metadata } from "next";
import Link from "next/link";

import { PartyBoothWordmark } from "@/components/layout/centred-pane";

const SUPPORT_EMAIL = "support@partybooth.app";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with PartyBooth, report a safety concern, or manage your account.",
  // App Store Connect publishes this URL as the product's support destination.
  // It must be public, usable while signed out, and discoverable by search.
  robots: { index: true, follow: true },
};

/** Public support destination used by the App Store listing. */
export default function SupportPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <main className="mx-auto w-full max-w-2xl px-5 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Link href="/" aria-label="PartyBooth home" className="inline-block">
          <PartyBoothWordmark />
        </Link>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Help and support</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          Tell us what went wrong and which party you were trying to use. Do not send a sign-in
          code, upload link, or any other private credential.
        </p>

        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=PartyBooth%20support`}
          className="mt-6 inline-flex min-h-11 items-center rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:brightness-110"
        >
          Email {SUPPORT_EMAIL}
        </a>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-muted">
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">A photo or person is the problem</h2>
            <p>
              Open the photo in PartyBooth and choose <strong className="text-ink">Report</strong>.
              The party&rsquo;s hosts receive the report without your name. You can also block the
              person so their media stops appearing for you.
            </p>
            <p>
              If you cannot get into the app, email us with the party name and a short description.
              Do not attach somebody else&rsquo;s private photo.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">Joining or uploading is not working</h2>
            <p>
              Ask the host for the current six-digit code: rotating an invitation makes the old QR
              code and code stop working. For an upload problem, keep PartyBooth open on My media;
              queued items resume when the phone is online again.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">Your account and data</h2>
            <p>
              You can request deletion in the app under Settings, or use the public{" "}
              <Link href="/account/deletion" className="underline underline-offset-2">
                account-deletion page
              </Link>
              . Read the{" "}
              <Link href="/privacy" className="underline underline-offset-2">
                privacy policy
              </Link>{" "}
              for what is removed and when.
            </p>
          </section>
        </div>

        <p className="mt-10 text-sm text-faint">
          <Link href="/terms" className="underline underline-offset-2">
            Terms
          </Link>{" "}
          ·{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy
          </Link>
        </p>
      </main>
    </div>
  );
}
