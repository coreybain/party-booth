import { OTP_POLICY, type OtpPurpose } from "@partybooth/contracts";

import type { EmailMessage } from "./types";

/**
 * Email bodies.
 *
 * Plain text only for now. Every one of these is transactional and read on a
 * phone in a hallway; the HTML version is a launch-week nicety, not a launch
 * requirement. Keeping them here (rather than inline at the call site) means
 * the copy can be reviewed in one place before the party.
 */

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

export interface OtpEmailInput {
  code: string;
  purpose: OtpPurpose;
}

export function otpEmail({ code, purpose }: OtpEmailInput): Omit<EmailMessage, "to"> {
  const minutes = Math.round(OTP_POLICY.ttlMs / 60_000);
  return {
    subject: `${code} — ${PURPOSE_SUBJECTS[purpose]}`,
    text: [
      PURPOSE_INTROS[purpose],
      "",
      `    ${code}`,
      "",
      `It expires in ${minutes} minutes and can only be used once.`,
      "If you didn't ask for this, you can ignore this email — nobody can sign in without the code.",
    ].join("\n"),
    tags: { kind: "otp", purpose },
  };
}

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
  return {
    subject: "You're invited to host on PartyBooth",
    text: [
      `${invitedByName} has invited you to host events on PartyBooth.`,
      ...(note ? ["", `"${note}"`] : []),
      "",
      "Accept the invitation here:",
      inviteUrl,
      "",
      `This link expires in ${expiresInDays} days.`,
    ].join("\n"),
    tags: { kind: "organiser_invite" },
  };
}

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
  return {
    subject: `You're a co-host for ${eventName}`,
    text: [
      `${invitedByName} has made you a co-host for "${eventName}" on PartyBooth.`,
      "",
      "As a co-host you can approve or decline photos, show the slideshow and share the join code.",
      "",
      "Open the event here:",
      joinUrl,
    ].join("\n"),
    tags: { kind: "cohost_invite" },
  };
}
