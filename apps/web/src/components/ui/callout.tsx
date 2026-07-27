import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type CalloutTone = "info" | "warning" | "danger" | "success";

const TONES: Record<CalloutTone, string> = {
  info: "border-line bg-surface text-muted",
  warning: "border-warning/35 bg-warning/8 text-warning",
  danger: "border-danger/40 bg-danger/8 text-danger",
  success: "border-positive/35 bg-positive/8 text-positive",
};

export interface CalloutProps {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly className?: string;
  /**
   * `polite` for status updates the user is waiting on, `assertive` for
   * validation failures. Omit for static explanatory copy.
   */
  readonly live?: "polite" | "assertive";
}

export function Callout({ tone = "info", title, children, className, live }: CalloutProps) {
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live}
      className={cn("rounded-xl border px-4 py-3 text-sm leading-relaxed", TONES[tone], className)}
    >
      {title ? <p className="font-medium text-ink">{title}</p> : null}
      {children ? <div className={cn(title && "mt-1")}>{children}</div> : null}
    </div>
  );
}
