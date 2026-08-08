"use client";

import { useRouter } from "next/navigation";

import { ArrowLeftIcon } from "@/components/icons";

/** Return to the screen that opened Profile, with a safe direct-entry fallback. */
export function ProfileBackButton({ returnTo }: { readonly returnTo?: string }) {
  const router = useRouter();

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      onClick={() => {
        if (returnTo !== undefined) router.replace(returnTo);
        else if (window.history.length > 1) router.back();
        else router.replace("/events");
      }}
    >
      <ArrowLeftIcon size={16} />
      Back
    </button>
  );
}
