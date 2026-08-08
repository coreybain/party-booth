import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { LogoMark } from "@/components/icons";

export interface CentredPaneProps {
  readonly children: ReactNode;
  /** Wordmark shown above the card. Pass `null` to omit it. */
  readonly brand?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  /** `sm` for a login card, `md` for a join/capture screen. */
  readonly width?: "sm" | "md";
}

const WIDTHS = { sm: "max-w-sm", md: "max-w-md" } as const;

/**
 * The generic centred-column layout: a single card in the middle of the
 * viewport, safe-area aware, comfortable one-handed on a phone.
 *
 * Used by organiser login, admin login and the join screen — and, from
 * Sprint 3, by the guest mobile-web capture flow. It is deliberately free of
 * any organiser/admin/guest specifics so it can be reused as-is.
 */
export function CentredPane({
  children,
  brand = <PartyBoothWordmark />,
  footer,
  className,
  width = "sm",
}: CentredPaneProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <main
        className={cn(
          "w-full",
          WIDTHS[width],
          // Breathing room under the notch / above the home indicator.
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          className,
        )}
      >
        {brand ? <div className="mb-8 flex justify-center">{brand}</div> : null}
        {children}
      </main>
      {footer ? (
        <footer className="mt-10 px-5 text-center text-xs text-faint">{footer}</footer>
      ) : null}
    </div>
  );
}

export function PartyBoothWordmark({
  className,
  compactOnMobile = false,
}: {
  readonly className?: string;
  readonly compactOnMobile?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
      <LogoMark size={26} className="text-accent" />
      <span
        className={cn(
          "text-lg font-semibold tracking-tight",
          compactOnMobile && "hidden sm:inline",
        )}
      >
        PartyBooth
      </span>
    </span>
  );
}
