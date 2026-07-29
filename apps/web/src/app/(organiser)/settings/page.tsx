import type { Metadata } from "next";

import { AccountSettings } from "@/components/account/account-settings";
import { PageHeader } from "@/components/layout/app-shell";

export const metadata: Metadata = { title: "Settings" };

/** Account settings only. Event settings live on each event's action menu. */
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your profile, sign-in methods and PartyBooth account."
      />
      <AccountSettings />
    </>
  );
}
