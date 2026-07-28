/**
 * The user terms — the UGC half of both stores' policies.
 *
 * Google Play's user-generated-content policy and Apple's guideline 1.2 both ask
 * for the same four things, and until Sprint 4's audit the repository contained
 * none of them: published terms that **define and prohibit** objectionable
 * content and behaviour, an acceptance the user actually gives, an in-app way to
 * report content, and a way to block an abusive user. The last two shipped; the
 * first two did not, and `docs/store/android-internal.md` claimed otherwise.
 *
 * What lives here is the part that has to be identical everywhere: the version
 * that is recorded against an account, and the list of prohibited things. The
 * prose lives at `/terms` on the website, because a policy is a document rather
 * than a data structure — but the *rules* it states are here so the app's
 * onboarding screen, the website's onboarding screen and the report sheet cannot
 * drift from it or from each other.
 */

/**
 * The version recorded against an account when it accepts.
 *
 * A date rather than an integer, because the question an auditor asks is "which
 * text did they agree to", and a date answers it against a document whose footer
 * carries the same date. Bumping it means every account is asked again, so it
 * moves only when the *rules* change — not when a typo is fixed.
 */
export const TERMS_VERSION = "2026-08-01";

/** Where the prose lives, relative to the public site origin. */
export const TERMS_PATH = "/terms";

/**
 * What the terms prohibit, in the words the product uses everywhere.
 *
 * Deliberately the same categories as `REPORT_REASONS` in `./media`, plus the
 * two that are about behaviour rather than about a file. A reporting flow whose
 * reasons do not match the rules is a reporting flow that collects complaints
 * nobody can act on.
 */
export const PROHIBITED_CONTENT = [
  {
    id: "sexual",
    title: "Sexual content and nudity",
    body: "No pornography, no sexual content, and no nudity — including images that are sexual in context rather than in content. There are no exceptions for a private party.",
  },
  {
    id: "minors",
    title: "Anything involving children",
    body: "No sexualised depiction of a minor, in any form, ever. This is reported to the authorities rather than moderated.",
  },
  {
    id: "violence",
    title: "Violence and gore",
    body: "No graphic violence, no injury or death presented for shock, and nothing that glorifies or encourages harming a person or an animal.",
  },
  {
    id: "hate",
    title: "Hate and harassment",
    body: "No slurs, no content attacking someone for who they are, no threats, no sustained targeting of an individual, and no encouragement of others to do any of it.",
  },
  {
    id: "illegal",
    title: "Illegal activity",
    body: "No content promoting or facilitating illegal acts, and no sale of regulated goods.",
  },
  {
    id: "privacy",
    title: "Other people's privacy",
    body: "Do not add a photograph of someone who has asked you not to, do not post identifying documents or anyone else's personal details, and do not use PartyBooth to record people who do not know they are being recorded.",
  },
  {
    id: "impersonation",
    title: "Impersonation and deception",
    body: "Do not pretend to be someone else, and do not upload content designed to mislead the people at the party about who took it or what it shows.",
  },
  {
    id: "spam",
    title: "Spam and advertising",
    body: "A party's camera roll is for the party. No advertising, no bulk uploads of unrelated material, no links to anything commercial.",
  },
] as const;

export type ProhibitedContentRule = (typeof PROHIBITED_CONTENT)[number];

/** The behaviour rules, which are about people rather than about files. */
export const COMMUNITY_RULES = [
  "Report anything that breaks these rules — every photo and video in a party has a report control, and reports go to the party's hosts.",
  "Block anyone you do not want to see or be seen by. Blocking is yours alone; nobody is told.",
  "A host may decline or remove anything in their own party, for any reason, and does not have to explain it.",
  "We may suspend or remove an account that breaks these rules, without notice, and may do so for a single serious breach.",
] as const;

/**
 * Has this account accepted the current terms?
 *
 * Compared for equality rather than ordered: an account carrying a *newer*
 * version than the deployment knows about is a rollback, and treating that as
 * accepted would mean a rolled-back deployment silently stops asking. Equality
 * is the honest reading and costs one extra tap in a case that should not happen.
 */
export function hasAcceptedTerms(record: { acceptedTermsVersion?: string | undefined }): boolean {
  return record.acceptedTermsVersion === TERMS_VERSION;
}

/** The single sentence shown next to the accept control, on both clients. */
export const TERMS_ACCEPTANCE_PROMPT =
  "By continuing you agree to the PartyBooth terms and the rules about what you may post.";

/** What an upload refused for want of acceptance says. */
export const TERMS_NOT_ACCEPTED_MESSAGE =
  "Agree to the PartyBooth terms before adding photos or video.";
