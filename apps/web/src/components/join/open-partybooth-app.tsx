"use client";

import { useCallback, useRef, type MouseEvent } from "react";

import { ArrowRightIcon, LogoMark } from "@/components/icons";
import { cn } from "@/lib/cn";
import { APP_STORE_FALLBACK_DELAY_MS, PARTYBOOTH_APP_STORE_URL } from "@/lib/mobile-app";

export interface OpenPartyBoothAppProps {
  readonly deepLink: string;
  readonly className?: string;
  readonly label?: string;
}

/**
 * Try the installed app first, then move the still-visible browser tab to the
 * App Store. Leaving Safari cancels the fallback so a successful handoff never
 * opens the store behind the app.
 */
export function OpenPartyBoothApp({
  deepLink,
  className,
  label = "Open in the PartyBooth app",
}: OpenPartyBoothAppProps) {
  const fallbackTimer = useRef<number | null>(null);

  const openApp = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();

      const cleanup = () => {
        if (fallbackTimer.current !== null) {
          window.clearTimeout(fallbackTimer.current);
          fallbackTimer.current = null;
        }
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("pagehide", cleanup);
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") cleanup();
      };

      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("pagehide", cleanup);
      fallbackTimer.current = window.setTimeout(() => {
        cleanup();
        window.location.assign(PARTYBOOTH_APP_STORE_URL);
      }, APP_STORE_FALLBACK_DELAY_MS);

      window.location.assign(deepLink);
    },
    [deepLink],
  );

  return (
    <a
      href={deepLink}
      onClick={openApp}
      className={cn(
        "flex h-14 w-full items-center justify-between gap-3 rounded-xl bg-accent px-5 text-base font-semibold text-on-accent transition-[filter] hover:brightness-110 active:brightness-95",
        className,
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-3">
        <LogoMark size={22} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <ArrowRightIcon size={20} className="shrink-0" />
    </a>
  );
}
