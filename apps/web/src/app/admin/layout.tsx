import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · PartyBooth Admin" },
  robots: { index: false, follow: false },
};

/**
 * Pass-through layout for `/admin`.
 *
 * The admin *chrome* lives in `admin/(console)/layout.tsx` so that
 * `/admin/login` — which must be reachable while signed out — does not inherit
 * the authenticated shell. This file only owns the metadata that both share.
 */
export default function AdminSegmentLayout({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
