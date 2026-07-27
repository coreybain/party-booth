import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import { siteUrl } from "@/lib/backend";

import "./globals.css";

export const metadata: Metadata = {
  // Undefined until NEXT_PUBLIC_SITE_URL is set; Next.js then falls back to the
  // deployment URL, which is correct for previews anyway.
  metadataBase: siteUrl === undefined ? null : new URL(siteUrl),
  title: {
    default: "PartyBooth",
    template: "%s · PartyBooth",
  },
  description: "Shared photos and video from your party, private to the people who were there.",
  applicationName: "PartyBooth",
  formatDetection: { telephone: false, email: false, address: false },
  // Private beta: nothing here should be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Guests will pinch-zoom a QR code; never block it.
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <body className="antialiased">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-on-accent"
        >
          Skip to content
        </a>
        <Providers>
          <div id="content">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
