import type { Metadata } from "next";
import Link from "next/link";

import { AccountDeletionRequest } from "@/components/account/account-deletion-request";
import { PartyBoothWordmark } from "@/components/layout/centred-pane";

export const metadata: Metadata = {
  title: "Delete your account",
  description: "Request deletion of your PartyBooth account and everything in it.",
  // Public and indexable. Play's policy asks for a **web** resource users can
  // reach to request deletion — reachable without the app, and findable without
  // a link somebody has to send you.
  robots: { index: true, follow: true },
};

/**
 * The web account-deletion route.
 *
 * `docs/store/android-internal.md` declared an external deletion URL to Play and
 * no such route existed: the privacy page pointed at the in-app control and
 * nothing else. Current Play policy requires a web resource from which a user
 * can *request* deletion of their account and its associated data, and the
 * declared URL has to work — it is checked.
 *
 * It is a real control rather than a mailto, and it is deliberately behind
 * sign-in, which is the identity verification: the deletion mutation acts on the
 * signed-in account and nothing else, so there is no form field naming somebody
 * else's address and therefore no way to aim this at a stranger. A signed-out
 * visitor gets the explanation and a way in.
 *
 * The page itself is a Server Component; the control is a client island, because
 * the whole point is that a signed-out visitor can read every word of it with no
 * backend at all — including in the empty-environment `next build`.
 */
export default function AccountDeletionPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Link href="/" aria-label="PartyBooth home" className="inline-block">
          <PartyBoothWordmark />
        </Link>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Delete your account</h1>
        <p className="mt-2 text-sm text-faint">
          You can do this here, or in the app under Settings → Delete account.
        </p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">What happens straight away</h2>
            <ul className="space-y-2 pl-5 [&>li]:list-disc">
              <li>You are signed out and lose access immediately.</li>
              <li>
                Your name comes off everything you posted — hosts and guests see &ldquo;Former
                guest&rdquo; from that moment.
              </li>
              <li>Any party you host is closed to new joins and new uploads.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">What happens after thirty days</h2>
            <p>
              A scheduled job erases the account and everything associated with it: your photos and
              videos and the stored files behind them, your memberships, your blocks, your
              notification devices, and your sign-in with Google or Apple.
            </p>
            <p>
              What survives is an anonymous placeholder that nothing can sign into. Our security
              records and a host&rsquo;s moderation history refer to it, and a record pointing at
              nothing is worse for everybody than one pointing at &ldquo;a former guest&rdquo;.
            </p>
            <p>
              A party you <em>hosted</em> is archived rather than erased — your guests&rsquo;
              photographs are not yours to delete. Everything <em>you</em> posted in it goes.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-ink">Changing your mind</h2>
            <p>
              During the thirty days you can ask us to cancel the deletion and the account comes
              back. After it, nothing can be brought back.
            </p>
            <p>
              Want a specific photo gone <em>now</em> instead of your whole account? Withdraw it
              from &ldquo;My media&rdquo; — that is immediate and permanent.
            </p>
          </section>

          <AccountDeletionRequest />
        </div>

        <p className="mt-10 text-sm text-faint">
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy
          </Link>
          {" · "}
          <Link href="/terms" className="underline underline-offset-2">
            Terms
          </Link>
        </p>
      </div>
    </div>
  );
}
