"use client";

import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import { useRouter } from "next/navigation";

import { ChevronDownIcon, MediaIcon, SettingsIcon, UsersIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface GuestMenuItem {
  readonly href: "#your-uploads" | "#party-gallery";
  readonly label: string;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

export type ConsoleMediaPanel = "uploads" | "gallery";

/** Unknown and legacy hashes fall back to the guest's own uploads. */
export function consoleMediaPanelFromHash(hash: string, showGallery: boolean): ConsoleMediaPanel {
  return hash === "#party-gallery" && showGallery ? "gallery" : "uploads";
}

export function consoleMediaPanelLabel(panel: ConsoleMediaPanel): "Your uploads" | "Party gallery" {
  return panel === "gallery" ? "Party gallery" : "Your uploads";
}

/** The role-safe settings tab for this membership, outside the host management sheet. */
export function guestEventSettingsHref(eventId: string): string {
  return `/event/${encodeURIComponent(eventId)}#settings`;
}

/** The menu mirrors visible sections; it never links to a gallery the event cannot show. */
export function guestEventMenuItems(showGallery: boolean): readonly GuestMenuItem[] {
  return [
    { href: "#your-uploads", label: "Your uploads", Icon: MediaIcon },
    ...(showGallery
      ? ([{ href: "#party-gallery", label: "Party gallery", Icon: UsersIcon }] as const)
      : []),
  ];
}

/** Quick actions for a guest using the wider organiser shell to visit someone else's party. */
export function GuestEventMenu({
  eventId,
  showGallery,
}: {
  readonly eventId: string;
  readonly showGallery: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<ConsoleMediaPanel>("uploads");

  useEffect(() => {
    const syncPanel = () => {
      setPanel(consoleMediaPanelFromHash(window.location.hash, showGallery));
    };

    syncPanel();
    window.addEventListener("hashchange", syncPanel);
    return () => {
      window.removeEventListener("hashchange", syncPanel);
    };
  }, [showGallery]);

  const label = consoleMediaPanelLabel(panel);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Open photo options, current view: ${label}`}
          >
            {label}
            <ChevronDownIcon size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {guestEventMenuItems(showGallery).map(({ href, label, Icon }) => (
            <DropdownMenuItem key={href} asChild>
              <a href={href} className="gap-2.5">
                <Icon size={17} className="text-muted" />
                {label}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="secondary"
        size="sm"
        onClick={() => router.push(guestEventSettingsHref(eventId))}
      >
        <SettingsIcon size={16} />
        Event settings
      </Button>
    </div>
  );
}
