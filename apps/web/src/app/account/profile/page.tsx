import type { Metadata } from "next";

import { ProfileSettings } from "@/components/account/account-settings";
import { CentredPane } from "@/components/layout/centred-pane";
import { SiteFooter } from "@/components/layout/site-footer";

import { ProfileBackButton } from "./profile-back-button";

export const metadata: Metadata = { title: "Your profile" };

/** Profile editing is account-level and available to guests as well as hosts. */
export default async function ProfilePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly returnTo?: string }>;
}) {
  const requestedReturnTo = (await searchParams).returnTo;
  const returnTo =
    requestedReturnTo?.startsWith("/") === true && !requestedReturnTo.startsWith("//")
      ? requestedReturnTo
      : undefined;

  return (
    <CentredPane width="md" footer={<SiteFooter note="Your profile travels with your account." />}>
      <div className="mb-4">
        <ProfileBackButton {...(returnTo === undefined ? {} : { returnTo })} />
      </div>
      <ProfileSettings />
    </CentredPane>
  );
}
