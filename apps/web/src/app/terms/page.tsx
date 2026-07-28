import type { Metadata } from "next";
import Link from "next/link";

import { PartyBoothWordmark } from "@/components/layout/centred-pane";
import { COMMUNITY_RULES, PROHIBITED_CONTENT, TERMS_VERSION } from "@/lib/contracts";

export const metadata: Metadata = {
  title: "Terms",
  description: "The rules for using PartyBooth, and what you may not post.",
  // Public and indexable, like `/privacy`, and for the same reason: both stores
  // ask for a terms URL a person can reach without an account, and a URL behind
  // a robots exclusion is one a reviewer can read but a guest cannot find.
  robots: { index: true, follow: true },
};

/**
 * The user terms — the document Play's UGC policy and Apple's guideline 1.2 both
 * ask for, and which did not exist.
 *
 * The audit found the store checklist claiming every UGC follow-up was satisfied
 * while the repository contained no terms at all and neither onboarding flow
 * asked anybody to agree to anything. Reporting and blocking shipped; the two
 * halves that make them mean something — a published document that **defines and
 * prohibits** objectionable content and behaviour, and a recorded acceptance —
 * did not.
 *
 * The rules themselves live in `@partybooth/contracts/terms` so that this page,
 * the onboarding prompt on both clients and the report sheet cannot drift apart.
 * This page is the prose around them.
 *
 * It is written in the second person and in short sentences, because the person
 * reading it is standing at a party with a phone in one hand.
 */
export default function TermsPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Link href="/" aria-label="PartyBooth home" className="inline-block">
          <PartyBoothWordmark />
        </Link>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Terms of use</h1>
        <p className="mt-2 text-sm text-faint">Version {TERMS_VERSION}</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section className="space-y-3">
            <p className="text-ink">
              PartyBooth is a shared camera roll for one party. By using it you agree to these
              terms. If you do not agree, do not use it — and you can delete your account at any
              time from Settings or at{" "}
              <Link href="/account/deletion" className="underline underline-offset-2">
                /account/deletion
              </Link>
              .
            </p>
            <p>PartyBooth is in private beta, invitation only, and for people aged 18 or over.</p>
          </section>

          <Section title="What you may not post">
            <p>
              Everything below applies to photos, videos, the name you choose, and anything you type
              into a report. It applies inside a private party exactly as it would in public — the
              other people at that party did not agree to see it either.
            </p>
            <List>
              {PROHIBITED_CONTENT.map((rule) => (
                <li key={rule.id}>
                  <Strong>{rule.title}.</Strong> {rule.body}
                </li>
              ))}
            </List>
          </Section>

          <Section title="How this is enforced">
            <List>
              {COMMUNITY_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </List>
            <p>
              Reports go to the hosts of the party the item is in, never to the person who posted
              it, and never with the reporter&rsquo;s name attached. A host can approve, decline or
              remove anything in their own party at any time.
            </p>
          </Section>

          <Section title="Your content stays yours">
            <p>
              You keep every right you have in the photos and videos you add. You give PartyBooth
              permission to store them and to show them to the other people in the same party, and
              to nobody else — that is the whole of the licence, and it ends when the content does.
            </p>
            <p>
              You can withdraw anything you posted, at any time, from &ldquo;My media&rdquo;.
              Withdrawal is permanent: the record is tombstoned and the stored file is deleted.
            </p>
          </Section>

          <Section title="Only post what you are allowed to post">
            <p>
              By adding something you confirm that it is yours to add, and that the people
              recognisable in it are content to be in a party&rsquo;s shared gallery. If somebody
              asks you to take a photo of them down, take it down.
            </p>
          </Section>

          <Section title="Ending your use of PartyBooth">
            <p>
              You can delete your account whenever you like. We may suspend or remove an account
              that breaks these rules — for a pattern of smaller breaches, or immediately for a
              serious one — and we do not have to warn you first.
            </p>
            <p>
              What happens to your data when an account ends is set out in the{" "}
              <Link href="/privacy" className="underline underline-offset-2">
                privacy policy
              </Link>
              , in plain terms: access ends at once, and everything is erased thirty days later.
            </p>
          </Section>

          <Section title="No warranty, and the limits of what we owe you">
            <p>
              PartyBooth is provided as it is. We do not promise it will be available, that an
              upload will succeed on a crowded wifi network, or that nothing will ever be lost. Keep
              your own copy of anything you would be upset to lose — the photo on your phone is the
              original, and what you send us is a copy.
            </p>
            <p>
              Nothing here limits anything that cannot be limited by law, including liability for
              death or personal injury caused by negligence, or for fraud.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              If these rules change in a way that matters, this page gets a new version number and
              you will be asked to agree again before you post anything else. Fixing a typo does not
              count.
            </p>
          </Section>
        </div>

        <p className="mt-10 text-sm text-faint">
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy
          </Link>
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function List({ children }: { readonly children: React.ReactNode }) {
  return <ul className="space-y-3 pl-5 [&>li]:list-disc">{children}</ul>;
}

function Strong({ children }: { readonly children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}
