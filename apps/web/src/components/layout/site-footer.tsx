import Link from "next/link";

/**
 * The one-line legal footer, and the only place the privacy link is written.
 *
 * App Review requires a privacy-policy URL that a person can reach without an
 * account, and "requires a URL" in practice means "requires that a reviewer can
 * find it from the first screen they see". So this sits under the sign-in card,
 * the join screens and the authenticated shell — every entry point there is.
 *
 * Deliberately not a component with slots and options: a footer that can be
 * configured is a footer that ends up configured *out* of one of those screens.
 */
export function SiteFooter({ note }: { readonly note?: string }) {
  return (
    <>
      Private beta · 18+{note === undefined ? "" : ` · ${note}`} · <PrivacyLink />
    </>
  );
}

export function PrivacyLink({ className }: { readonly className?: string }) {
  return (
    <Link href="/privacy" className={className ?? "underline underline-offset-2 hover:text-muted"}>
      Privacy
    </Link>
  );
}
