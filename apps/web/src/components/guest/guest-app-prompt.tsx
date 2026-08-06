"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import { XIcon } from "@/components/icons";
import { OpenPartyBoothApp } from "@/components/join/open-partybooth-app";
import { PARTYBOOTH_APP_URL } from "@/lib/mobile-app";

export const GUEST_APP_PROMPT_DISMISSED_KEY = "partybooth:guest-app-prompt-dismissed:v1";
const APP_PROMPT_CHANGED_EVENT = "partybooth:guest-app-prompt-changed";

export function appPromptWasDismissed(value: string | null): boolean {
  return value === "1";
}

export function useGuestAppPrompt() {
  const [dismissedForSession, setDismissedForSession] = useState(false);
  const storedVisible = useSyncExternalStore(
    subscribeToPromptPreference,
    readPromptPreference,
    () => false,
  );

  const dismiss = useCallback(() => {
    setDismissedForSession(true);
    try {
      window.localStorage.setItem(GUEST_APP_PROMPT_DISMISSED_KEY, "1");
      window.dispatchEvent(new Event(APP_PROMPT_CHANGED_EVENT));
    } catch {
      // The current dismissal still applies even if this browser cannot persist it.
    }
  }, []);

  return { visible: storedVisible && !dismissedForSession, dismiss } as const;
}

function readPromptPreference(): boolean {
  try {
    return !appPromptWasDismissed(window.localStorage.getItem(GUEST_APP_PROMPT_DISMISSED_KEY));
  } catch {
    // Private browsing/storage restrictions should not make the prompt unusable.
    return true;
  }
}

function subscribeToPromptPreference(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === GUEST_APP_PROMPT_DISMISSED_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(APP_PROMPT_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(APP_PROMPT_CHANGED_EVENT, onChange);
  };
}

export function GuestAppPrompt({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <aside
      aria-label="Open PartyBooth app"
      className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 mx-auto max-w-md rounded-2xl border border-accent/35 bg-surface/95 p-3 pr-12 shadow-2xl shadow-black/55 backdrop-blur"
    >
      <button
        type="button"
        aria-label="Dismiss app suggestion and don’t show it again"
        onClick={onDismiss}
        className="absolute right-2 top-2 grid size-11 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <XIcon size={19} />
      </button>
      <p className="mb-2 px-1 text-sm font-medium text-ink">Take the party with you</p>
      <OpenPartyBoothApp
        deepLink={PARTYBOOTH_APP_URL}
        label="Open the PartyBooth app"
        className="h-12 px-4 text-sm"
      />
    </aside>
  );
}
