import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Inline monospace for variable names, file names and error references.
 *
 * Deliberately *not* the `.text-code` utility: that one adds the wide letter
 * spacing a six-digit code needs, which makes an identifier like
 * `NEXT_PUBLIC_CONVEX_URL` unreadable and overflow its container.
 */
export function Code({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <code
      className={cn(
        "rounded bg-raised px-1 py-0.5 font-mono text-[0.9em] break-all text-ink",
        className,
      )}
    >
      {children}
    </code>
  );
}
