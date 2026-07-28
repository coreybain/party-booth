import type { Metadata } from "next";
import Link from "next/link";

import { PartyBoothWordmark } from "@/components/layout/centred-pane";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What PartyBooth stores, who can see it, and how to get rid of it.",
  // The one page in this app that *should* be reachable and indexable: App
  // Review requires a public privacy-policy URL, and a URL behind a robots
  // exclusion is a URL a reviewer can still read but a person cannot find.
  robots: { index: true, follow: true },
};

/**
 * The privacy policy — a **public** route, deliberately outside every
 * authenticated shell.
 *
 * App Review requires a privacy-policy URL that works without an account, and
 * PLAN.md's App Review line lists it alongside reporting, blocking and in-app
 * deletion. It is written in the second person and in plain English because the
 * people who will actually read it are guests at a party deciding whether to
 * let a stranger's website have their photographs.
 *
 * Everything below is a statement about how the code behaves, not an aspiration:
 * private ACLs and permission-checked short-lived URLs (ADR 0004), client-side
 * re-encoding that drops the EXIF/GPS block (ADR 0004 §7, ADR 0008), moderation
 * visibility (`canSeeMedia`), permanent withdrawal, and account deletion that
 * revokes access immediately. If any sentence here stops being true, the code is
 * the bug — not this page.
 */
export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Link href="/" aria-label="PartyBooth home" className="inline-block">
          <PartyBoothWordmark />
        </Link>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-2 text-sm text-faint">Last updated 1 August 2026</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-muted">
          <section className="space-y-3">
            <p className="text-ink">
              PartyBooth is a shared camera roll for one party. You join a specific event, add
              photos and video to it, and see what the host has approved. That is the whole product,
              and this page is the whole story of what it does with your data.
            </p>
            <p>
              We do not sell anything to anyone, we do not run advertising, we do not build profiles
              of you, and we do not use your photos to train anything.
            </p>
          </section>

          <Section title="What we store">
            <List>
              <li>
                <Strong>Your account.</Strong> Your email address, the name you chose, and — if you
                signed in with Google or Apple — the identifier they give us. Nothing else from
                those accounts.
              </li>
              <li>
                <Strong>What you send.</Strong> The photos and videos you add to an event, plus the
                technical facts that go with them: file size, format, dimensions, how long a video
                runs, and when it was sent.
              </li>
              <li>
                <Strong>Who is in which party.</Strong> Which events you have joined, when, and what
                role you have in them.
              </li>
              <li>
                <Strong>A security log.</Strong> Sign-ins, joins, uploads, moderation decisions and
                account changes are recorded so a host or an administrator can answer "what
                happened?". These records name accounts and actions, never the contents of a photo.
              </li>
              <li>
                <Strong>Crash and error reports.</Strong> When something breaks we get a report,
                with email addresses, tokens and URLs scrubbed out of it before it leaves your
                device.
              </li>
            </List>
          </Section>

          <Section title="Location data in your photos">
            <p>
              Cameras write hidden information into every photo: where you were, to within a few
              metres, along with your phone's model and the exact time. We do not want it and we do
              not keep it.
            </p>
            <p>
              Before a photo leaves your phone, PartyBooth re-saves it. That process keeps the
              picture and drops everything else — there is no location block left to strip, because
              one is never written. If your device cannot do that, the photo is refused rather than
              sent as-is.
            </p>
            <p>
              <Strong>
                Video is the exception, and we would rather say so than imply otherwise.
              </Strong>{" "}
              A web browser cannot re-encode a video, so a clip is sent as your camera recorded it
              and may still carry that information inside the file. Only you and the party's hosts
              can ever play the original; everyone else sees a thumbnail we made ourselves. If that
              matters to you, turn location off in your camera settings before recording, or send a
              photo instead.
            </p>
          </Section>

          <Section title="Who can see what you send">
            <List>
              <li>
                <Strong>Nothing is public.</Strong> Files are stored privately. There is no such
                thing as "the link to a photo" — every view is checked against who you are and hands
                out an address that stops working within minutes.
              </li>
              <li>
                <Strong>Waiting and declined items are nearly invisible.</Strong> Until a host
                approves something, only you and the party's hosts can see it. If a host declines
                it, that stays true for ever: it is never shown to other guests.
              </li>
              <li>
                <Strong>Approved items are visible to the people at that party</Strong> — the guests
                who joined that event, and nobody else. Not other events, not the internet.
              </li>
              <li>
                <Strong>Hosts see everything sent to their own party</Strong>, because they cannot
                moderate what they cannot see.
              </li>
              <li>
                <Strong>Administrators do not look at your photos.</Strong> The people who run
                PartyBooth can see accounts, events and counts, and are not able to open the
                pictures.
              </li>
            </List>
          </Section>

          <Section title="No face recognition">
            <p>
              We do not use facial recognition, face grouping, face matching, or any other biometric
              analysis — not to tag people, not to sort photos, not at all. No automated system
              looks at the content of your photos today; hosts approve or decline them themselves.
              If that ever changes, this page changes first.
            </p>
          </Section>

          <Section title="Taking something back">
            <p>
              You can withdraw anything you sent, at any time, whether or not it was approved. It
              disappears from every gallery and slideshow immediately and cannot be restored by you,
              by a host, or by us. The stored file is deleted.
            </p>
            <p>
              You can also report another guest's photo to the party's hosts, and block another
              guest so their photos stop appearing for you. Blocking is silent — they are not told.
            </p>
          </Section>

          <Section title="Deleting your account">
            <p>
              You can delete your account from inside the app, in Settings — or on the web, at{" "}
              <Link href="/account/deletion" className="underline underline-offset-2">
                partybooth.app/account/deletion
              </Link>
              . Either way it takes effect at once: you lose access immediately and the account is
              scheduled for permanent erasure thirty days later.
            </p>
            <p>
              When those thirty days are up, a scheduled job erases the lot: your photos and videos
              and the stored files behind them, your memberships, your blocks, your notification
              devices, and your sign-in with Google or Apple. What survives is an anonymous
              placeholder that nothing can sign into, because our security records and a
              host&rsquo;s moderation history refer to it and a record that points at nothing is
              worse for everybody than one that points at &ldquo;a former guest&rdquo;.
            </p>
            <p>
              Until the thirty days are up, your photos stay in the party with the attribution
              removed — they show as coming from a former guest — so that a host who is mid-event
              does not lose the evening. During that window you can also change your mind: ask us
              and the deletion is cancelled. After it, nothing can be brought back.
            </p>
            <p>
              If you host a party and delete your account, the party is <em>archived</em> rather
              than erased. Your guests&rsquo; photographs are not yours to delete.
            </p>
          </Section>

          <Section title="How long we keep things">
            <List>
              <li>
                <Strong>Photos and videos</Strong> stay while the event exists. An event you delete
                takes its media with it.
              </li>
              <li>
                <Strong>Withdrawn items</Strong> are removed from storage as soon as the withdrawal
                is recorded.
              </li>
              <li>
                <Strong>Deleted accounts</Strong> are erased after thirty days — the account, its
                media, the stored files, the relationships and the sign-in credential. Access ends
                the moment you ask, not thirty days later.
              </li>
              <li>
                <Strong>Security records</Strong> are kept longer than the rest, because their whole
                purpose is to be checkable after the fact.
              </li>
            </List>
          </Section>

          <Section title="Who else touches your data">
            <p>
              PartyBooth runs on a small number of services, each doing one job: hosting the site,
              running the database, storing files, sending sign-in emails, and collecting crash
              reports. They process data on our instructions and are not permitted to use it for
              anything of their own.
            </p>
            <p>
              Files are stored in the United States (Portland, Oregon) and the database in Virginia.
            </p>
          </Section>

          <Section title="Age">
            <p>
              PartyBooth is for adults — 18 and over. It is invitation-only and is not directed at
              children. If you believe a child has an account, tell the host of the party they
              joined and it will be removed.
            </p>
          </Section>

          <Section title="Getting in touch">
            <p>
              PartyBooth is in a private beta run by the person who invited you. Ask them first —
              they are the host of your party and can remove media, remove guests, and delete the
              whole event. For anything they cannot fix, reply to the email that sent you your
              sign-in code.
            </p>
          </Section>
        </div>

        <p className="mt-10 text-sm">
          <Link href="/" className="text-accent underline underline-offset-2">
            Back to PartyBooth
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
  return <ul className="space-y-2.5 pl-5 [&>li]:list-disc [&>li]:marker:text-faint">{children}</ul>;
}

function Strong({ children }: { readonly children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}
