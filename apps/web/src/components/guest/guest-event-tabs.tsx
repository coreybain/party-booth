"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { LogoMark, MediaIcon, SettingsIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export const GUEST_EVENT_TABS = ["camera", "gallery", "settings"] as const;
export type GuestEventTab = (typeof GUEST_EVENT_TABS)[number];

const TAB_COPY: Record<GuestEventTab, string> = {
  camera: "Camera",
  gallery: "Gallery",
  settings: "Settings",
};

/** Preserve old media hashes when opening bookmarks made before tabs existed. */
export function guestEventTabFromHash(hash: string): GuestEventTab {
  const value = hash.replace(/^#/, "").toLowerCase();
  if (value === "gallery" || value === "party-gallery" || value === "your-uploads") {
    return "gallery";
  }
  if (value === "settings") return "settings";
  return "camera";
}

export function guestEventTabForKey(current: GuestEventTab, key: string): GuestEventTab | null {
  const index = GUEST_EVENT_TABS.indexOf(current);
  if (key === "Home") return "camera";
  if (key === "End") return "settings";
  if (key === "ArrowLeft") {
    return (
      GUEST_EVENT_TABS[(index - 1 + GUEST_EVENT_TABS.length) % GUEST_EVENT_TABS.length] ?? current
    );
  }
  if (key === "ArrowRight") {
    return GUEST_EVENT_TABS[(index + 1) % GUEST_EVENT_TABS.length] ?? current;
  }
  return null;
}

export function GuestEventTabs({
  active,
  onChange,
}: {
  readonly active: GuestEventTab;
  readonly onChange: (tab: GuestEventTab) => void;
}) {
  const buttons = useRef<Partial<Record<GuestEventTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: GuestEventTab) => {
    const next = guestEventTabForKey(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    buttons.current[next]?.focus();
  };

  return (
    <nav
      className="sticky top-[max(0.5rem,env(safe-area-inset-top))] z-30 rounded-2xl border border-line bg-surface/95 p-1 shadow-lg shadow-bg/40 backdrop-blur"
      aria-label="Event areas"
    >
      <div role="tablist" aria-label="Event areas" className="grid grid-cols-3 gap-1">
        {GUEST_EVENT_TABS.map((tab) => {
          const selected = active === tab;
          const Icon = tab === "camera" ? LogoMark : tab === "gallery" ? MediaIcon : SettingsIcon;
          return (
            <button
              key={tab}
              ref={(node) => {
                buttons.current[tab] = node;
              }}
              id={`event-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`event-panel-${tab}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab)}
              onKeyDown={(event) => onKeyDown(event, tab)}
              className={cn(
                "inline-flex min-h-12 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                selected
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:bg-raised hover:text-ink",
              )}
            >
              <Icon size={18} className="shrink-0 max-[340px]:hidden" />
              <span className="truncate">{TAB_COPY[tab]}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function GuestEventTabPanel({
  tab,
  active,
  children,
  className,
}: {
  readonly tab: GuestEventTab;
  readonly active: GuestEventTab;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const selected = tab === active;

  return (
    <section
      id={`event-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`event-tab-${tab}`}
      tabIndex={selected ? 0 : -1}
      hidden={!selected}
      className={cn(
        "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
    </section>
  );
}
