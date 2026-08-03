import { OTP_POLICY, type OtpPurpose } from "@partybooth/contracts";

import type { EmailMessage } from "./types";

/**
 * Email bodies — plain text *and* HTML.
 *
 * Every one of these is transactional and read on a phone in a hallway, so the
 * plain-text part stays first-class: it is the accessible fallback, the version
 * a watch or a screen reader reads out, and the only version the console sender
 * ever prints. The HTML part is built from the same inputs so the two can never
 * drift in substance — same code, same links, same expiry.
 *
 * The HTML is hand-rolled on purpose. No templating dependency (the Convex
 * runtime is a V8 isolate and this is string concatenation), no external CSS,
 * no images, no web fonts, no JavaScript — none of which survive a real inbox.
 * What survives is: tables with `role="presentation"`, inline styles on every
 * element that matters, `bgcolor` alongside the inline background, a 600px
 * shell, and a `<style>` block used only for progressive enhancement (mobile
 * breakpoint, Outlook.com dark-mode overrides).
 *
 * Colours mirror the product tokens in `apps/web/src/app/globals.css`. They are
 * duplicated rather than imported because the backend cannot read the web app's
 * stylesheet; if the brand moves, move both.
 *
 * **Everything interpolated is escaped.** Inviter names, event names and notes
 * are user-supplied, and URLs are only ever emitted as an `href` after being
 * confirmed `http(s)`. See {@link escapeHtml} and {@link safeHref}.
 */

/* -------------------------------------------------------------------------- */
/* Brand                                                                       */
/* -------------------------------------------------------------------------- */

/** Mirrors the `@theme` block in `apps/web/src/app/globals.css`. */
const BRAND = {
  canvas: "#0a0a0f",
  surface: "#14141d",
  raised: "#1e1e2b",
  line: "#2b2b3c",
  ink: "#f5f3f8",
  muted: "#a5a1b6",
  accent: "#ff4d8d",
  accentSoft: "#3a1024",
  onAccent: "#1a0410",
} as const;

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Courier New',monospace";

const PRODUCT_NAME = "PartyBooth";
const FOOTER_LINE = "PartyBooth — party photos, on the wall in seconds.";

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Escape a string for interpolation into HTML text or a double-quoted
 * attribute. Covers `&`, `<`, `>`, `"` and `'` — enough for both positions,
 * which is why there is one function rather than two that can be mixed up.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An escaped `href`, or `undefined` if the URL is not a plain `http(s)` link.
 *
 * We build every one of these URLs ourselves from `SITE_URL`, so anything else
 * arriving here is a misconfiguration or an injection attempt. Returning
 * `undefined` means the caller renders the URL as inert text instead of a
 * clickable `javascript:` or `data:` link.
 */
function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return undefined;
  return escapeHtml(trimmed);
}

/** Escaped, with newlines turned into line breaks. For free-text notes. */
function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br />");
}

/* -------------------------------------------------------------------------- */
/* Building blocks                                                             */
/* -------------------------------------------------------------------------- */

/** Horizontal padding of the card, matched by the mobile override below. */
const PAD = "padding:0 40px;";

/**
 * Every block helper takes **plain text and escapes it itself**. That is the
 * whole safety story: there is no "trust me, this is already HTML" argument
 * anywhere, so no call site can forget to escape one.
 */
function heading(text: string): string {
  return `<tr><td class="pb-pad" style="${PAD}padding-top:8px;"><h1 class="pb-ink" style="margin:0;font-family:${SANS};font-size:24px;line-height:32px;font-weight:700;color:${BRAND.ink};">${escapeHtml(text)}</h1></td></tr>`;
}

function paragraph(text: string, { muted = false }: { muted?: boolean } = {}): string {
  const color = muted ? BRAND.muted : BRAND.ink;
  const cls = muted ? "pb-muted" : "pb-ink";
  return `<tr><td class="pb-pad" style="${PAD}padding-top:16px;"><p class="${cls}" style="margin:0;font-family:${SANS};font-size:16px;line-height:24px;color:${color};">${escapeHtml(text)}</p></td></tr>`;
}

function spacer(height: number): string {
  return `<tr><td style="font-size:0;line-height:0;height:${height}px;">&nbsp;</td></tr>`;
}

function divider(): string {
  return `<tr><td class="pb-pad" style="${PAD}padding-top:28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="pb-line" style="height:1px;line-height:1px;font-size:0;background-color:${BRAND.line};">&nbsp;</td></tr></table></td></tr>`;
}

/**
 * The OTP, as the loudest thing in the message.
 *
 * Big, monospaced, tabular, on a raised panel. The letter-spacing is paired
 * with a matching `text-indent` so the tracking does not shove the code off
 * centre, and it is plain selectable text — no images, nothing to stop a
 * long-press "copy" on a phone.
 */
function codePanel(code: string): string {
  return [
    `<tr><td class="pb-pad" style="${PAD}padding-top:24px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.raised}" class="pb-raised" style="background-color:${BRAND.raised};border:1px solid ${BRAND.line};border-radius:14px;">`,
    `<tr><td align="center" style="padding:22px 16px 8px;">`,
    `<p class="pb-muted" style="margin:0;font-family:${SANS};font-size:12px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">Your code</p>`,
    `</td></tr>`,
    `<tr><td align="center" style="padding:0 16px 22px;">`,
    `<div class="pb-code pb-ink" style="font-family:${MONO};font-size:40px;line-height:52px;font-weight:700;letter-spacing:8px;text-indent:8px;color:${BRAND.ink};">${escapeHtml(code)}</div>`,
    `</td></tr>`,
    `</table></td></tr>`,
  ].join("");
}

/**
 * A call-to-action button, table-based so Outlook still paints the background.
 *
 * `href` is the output of {@link safeHref} — already validated and escaped, so
 * this is only ever reached for a real `http(s)` URL. `label` must describe the
 * destination on its own: the colour is decoration, not information.
 */
function button(href: string, label: string): string {
  return [
    `<tr><td class="pb-pad" align="center" style="${PAD}padding-top:28px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="pb-btn"><tr>`,
    `<td class="pb-btn-cell" align="center" bgcolor="${BRAND.accent}" style="background-color:${BRAND.accent};border-radius:999px;">`,
    `<a href="${href}" style="display:inline-block;padding:14px 32px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:700;color:${BRAND.onAccent};text-decoration:none;">${escapeHtml(label)}</a>`,
    `</td></tr></table></td></tr>`,
  ].join("");
}

/**
 * The same URL again, visible and copyable.
 *
 * Buttons get stripped, mis-tapped and blocked; the raw link is the fallback.
 * When the URL is not a safe `http(s)` one it is still shown, just not linked.
 */
function fallbackLink(url: string): string {
  const href = safeHref(url);
  const text = escapeHtml(url.trim());
  const shown = href
    ? `<a href="${href}" class="pb-link" style="color:${BRAND.accent};text-decoration:underline;word-break:break-all;">${text}</a>`
    : `<span style="word-break:break-all;">${text}</span>`;
  return [
    `<tr><td class="pb-pad" style="${PAD}padding-top:20px;">`,
    `<p class="pb-muted" style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:18px;color:${BRAND.muted};">Or paste this link into your browser:</p>`,
    `<p style="margin:0;font-family:${MONO};font-size:13px;line-height:20px;color:${BRAND.accent};">${shown}</p>`,
    `</td></tr>`,
  ].join("");
}

/** A quoted note from the person doing the inviting. */
function quote(note: string): string {
  return [
    `<tr><td class="pb-pad" style="${PAD}padding-top:20px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.accentSoft}" class="pb-soft" style="background-color:${BRAND.accentSoft};border-left:3px solid ${BRAND.accent};border-radius:0 10px 10px 0;">`,
    `<tr><td style="padding:14px 18px;"><p class="pb-ink" style="margin:0;font-family:${SANS};font-size:15px;line-height:23px;font-style:italic;color:${BRAND.ink};">${escapeMultiline(note)}</p></td></tr>`,
    `</table></td></tr>`,
  ].join("");
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Dark-mode survival kit.
 *
 * The design is already dark, so the danger is a client *inverting* it and
 * leaving light text on a now-light panel. Declaring `color-scheme: dark` tells
 * Apple Mail and iOS not to touch it; the `[data-ogsc]`/`[data-ogsb]` rules put
 * the colours back after Outlook.com's rewrite. Clients that drop `<style>`
 * entirely still get the full design, because every one of these values is also
 * set inline.
 */
const HEAD_STYLE = [
  `:root{color-scheme:dark;supported-color-schemes:dark;}`,
  `body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;}`,
  `table{border-collapse:collapse;}`,
  `img{border:0;}`,
  `a{color:${BRAND.accent};}`,
  `@media only screen and (max-width:620px){`,
  `.pb-shell{width:100%!important;}`,
  `.pb-pad{padding-left:24px!important;padding-right:24px!important;}`,
  `.pb-code{font-size:32px!important;letter-spacing:6px!important;text-indent:6px!important;}`,
  `.pb-btn,.pb-btn-cell{width:100%!important;}`,
  `.pb-btn-cell a{display:block!important;}`,
  `}`,
  // Outlook.com / Windows Mail dark mode rewrites colours on these hooks.
  `[data-ogsc] .pb-canvas,[data-ogsb] .pb-canvas{background-color:${BRAND.canvas}!important;}`,
  `[data-ogsc] .pb-surface,[data-ogsb] .pb-surface{background-color:${BRAND.surface}!important;}`,
  `[data-ogsc] .pb-raised,[data-ogsb] .pb-raised{background-color:${BRAND.raised}!important;}`,
  `[data-ogsc] .pb-soft,[data-ogsb] .pb-soft{background-color:${BRAND.accentSoft}!important;}`,
  `[data-ogsc] .pb-line,[data-ogsb] .pb-line{background-color:${BRAND.line}!important;}`,
  `[data-ogsc] .pb-ink{color:${BRAND.ink}!important;}`,
  `[data-ogsc] .pb-muted{color:${BRAND.muted}!important;}`,
  `[data-ogsc] .pb-accent,[data-ogsc] .pb-link{color:${BRAND.accent}!important;}`,
  `[data-ogsc] .pb-btn-cell,[data-ogsb] .pb-btn-cell{background-color:${BRAND.accent}!important;}`,
  `[data-ogsc] .pb-btn-cell a{color:${BRAND.onAccent}!important;}`,
].join("");

/** Wordmark. Text only — image-blocking inboxes are the common case. */
const WORDMARK =
  `<span class="pb-ink" style="font-family:${SANS};font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:${BRAND.ink};">Party</span>` +
  `<span class="pb-accent" style="font-family:${SANS};font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:${BRAND.accent};">Booth</span>`;

interface LayoutInput {
  /** Inbox preview line. Shown by the client, never rendered in the body. */
  preheader: string;
  /** `<tr>` rows, top to bottom, built by the block helpers above. */
  rows: string[];
  /** Small print under the card. */
  footerNote: string;
  /** Document title — some clients read it out. Escaped here. */
  title: string;
}

function layout({ preheader, rows, footerNote, title }: LayoutInput): string {
  return [
    `<!doctype html>`,
    `<html lang="en" dir="ltr" style="color-scheme:dark;supported-color-schemes:dark;">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<meta name="x-apple-disable-message-reformatting" />`,
    `<meta name="color-scheme" content="dark" />`,
    `<meta name="supported-color-schemes" content="dark" />`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${HEAD_STYLE}</style>`,
    `</head>`,
    `<body class="pb-canvas" bgcolor="${BRAND.canvas}" style="margin:0;padding:0;background-color:${BRAND.canvas};">`,
    // Preheader: the inbox preview text. Hidden in the body, then padded with
    // zero-width characters so the client does not trail body copy after it.
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.canvas};opacity:0;">${escapeHtml(preheader)}${"&#8199;&#65279;&#847;".repeat(40)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pb-canvas" bgcolor="${BRAND.canvas}" style="background-color:${BRAND.canvas};width:100%;">`,
    `<tr><td align="center" style="padding:32px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="pb-shell" style="width:600px;max-width:600px;">`,
    // Header
    `<tr><td class="pb-pad" style="${PAD}padding-bottom:14px;">${WORDMARK}</td></tr>`,
    // Card
    `<tr><td>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pb-surface" bgcolor="${BRAND.surface}" style="background-color:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:18px;">`,
    spacer(24),
    ...rows,
    spacer(32),
    `</table>`,
    `</td></tr>`,
    // Footer
    `<tr><td class="pb-pad" style="${PAD}padding-top:20px;">`,
    `<p class="pb-muted" style="margin:0 0 4px;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.muted};">${escapeHtml(FOOTER_LINE)}</p>`,
    `<p class="pb-muted" style="margin:0;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.muted};">${escapeHtml(footerNote)}</p>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body></html>`,
  ].join("");
}

/* -------------------------------------------------------------------------- */
/* OTP                                                                         */
/* -------------------------------------------------------------------------- */

const PURPOSE_SUBJECTS: Record<OtpPurpose, string> = {
  organiserSignIn: "Your PartyBooth sign-in code",
  guestSignIn: "Your PartyBooth code",
  adminSignIn: "Your PartyBooth admin code",
  emailVerification: "Verify your email for PartyBooth",
};

const PURPOSE_INTROS: Record<OtpPurpose, string> = {
  organiserSignIn: "Here's your code to sign in to PartyBooth.",
  guestSignIn: "Here's your code to join the party.",
  adminSignIn: "Here's your code to sign in to the PartyBooth admin console.",
  emailVerification: "Here's your code to verify this email address.",
};

const PURPOSE_HEADINGS: Record<OtpPurpose, string> = {
  organiserSignIn: "Sign in to PartyBooth",
  guestSignIn: "Join the party",
  adminSignIn: "Sign in to the admin console",
  emailVerification: "Verify your email",
};

const NOT_YOU =
  "If you didn't ask for this, you can ignore this email — nobody can sign in without the code.";

export interface OtpEmailInput {
  code: string;
  purpose: OtpPurpose;
}

export function otpEmail({ code, purpose }: OtpEmailInput): Omit<EmailMessage, "to"> {
  const minutes = Math.round(OTP_POLICY.ttlMs / 60_000);
  const expiry = `It expires in ${minutes} minutes and can only be used once.`;

  return {
    // The code leads the subject: on a phone it lands in the notification, and
    // most people never open the message at all.
    subject: `${code} — ${PURPOSE_SUBJECTS[purpose]}`,
    text: [PURPOSE_INTROS[purpose], "", code, "", expiry, NOT_YOU, "", `— ${PRODUCT_NAME}`].join(
      "\n",
    ),
    html: layout({
      title: PURPOSE_SUBJECTS[purpose],
      preheader: `${code} is your ${PRODUCT_NAME} code. ${expiry}`,
      rows: [
        heading(PURPOSE_HEADINGS[purpose]),
        paragraph(PURPOSE_INTROS[purpose]),
        codePanel(code),
        paragraph(expiry, { muted: true }),
        divider(),
        paragraph(NOT_YOU, { muted: true }),
      ],
      footerNote: "This is an automated message — please don't reply to it.",
    }),
    tags: { kind: "otp", purpose },
  };
}

/* -------------------------------------------------------------------------- */
/* Organiser invitation                                                        */
/* -------------------------------------------------------------------------- */

export interface OrganiserInviteEmailInput {
  inviteUrl: string;
  invitedByName: string;
  note?: string | undefined;
  expiresInDays: number;
}

export function organiserInviteEmail({
  inviteUrl,
  invitedByName,
  note,
  expiresInDays,
}: OrganiserInviteEmailInput): Omit<EmailMessage, "to"> {
  const lead = `${invitedByName} has invited you to host events on PartyBooth.`;
  const expiry = `This link expires in ${expiresInDays} days.`;
  const blurb =
    "Hosting gets you your own party page: guests scan a code, take photos, and everything lands on the slideshow.";
  const href = safeHref(inviteUrl);

  return {
    subject: "You're invited to host on PartyBooth",
    text: [
      lead,
      ...(note ? ["", `"${note}"`] : []),
      "",
      blurb,
      "",
      "Accept the invitation here:",
      inviteUrl,
      "",
      expiry,
      "",
      `— ${PRODUCT_NAME}`,
    ].join("\n"),
    html: layout({
      title: "You're invited to host on PartyBooth",
      preheader: `${invitedByName} invited you to host events on PartyBooth. ${expiry}`,
      rows: [
        heading("You're invited to host"),
        paragraph(lead),
        ...(note ? [quote(note)] : []),
        paragraph(blurb, { muted: true }),
        ...(href ? [button(href, "Accept the invitation")] : []),
        fallbackLink(inviteUrl),
        divider(),
        paragraph(expiry, { muted: true }),
      ],
      footerNote:
        "Not expecting this? You can ignore it — the invitation only works from this link.",
    }),
    tags: { kind: "organiser_invite" },
  };
}

/* -------------------------------------------------------------------------- */
/* Co-host invitation                                                          */
/* -------------------------------------------------------------------------- */

export interface CohostInviteEmailInput {
  eventName: string;
  invitedByName: string;
  joinUrl: string;
}

export function cohostInviteEmail({
  eventName,
  invitedByName,
  joinUrl,
}: CohostInviteEmailInput): Omit<EmailMessage, "to"> {
  const lead = `${invitedByName} has made you a co-host for "${eventName}" on PartyBooth.`;
  const duties =
    "As a co-host you can approve or decline photos, show the slideshow and share the join code.";
  const href = safeHref(joinUrl);

  return {
    subject: `You're a co-host for ${eventName}`,
    text: [lead, "", duties, "", "Open the event here:", joinUrl, "", `— ${PRODUCT_NAME}`].join(
      "\n",
    ),
    html: layout({
      title: `You're a co-host for ${eventName}`,
      preheader: `${invitedByName} made you a co-host for ${eventName}.`,
      rows: [
        heading("You're a co-host"),
        paragraph(lead),
        paragraph(duties, { muted: true }),
        ...(href ? [button(href, "Open the event")] : []),
        fallbackLink(joinUrl),
      ],
      footerNote:
        "Not expecting this? You can ignore it — nothing happens until you open the event.",
    }),
    tags: { kind: "cohost_invite" },
  };
}
