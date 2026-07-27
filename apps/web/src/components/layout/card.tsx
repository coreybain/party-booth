import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: "div" | "section" | "article";
}

/** A surface panel. The only container style in the app. */
export function Card({ children, className, as: Tag = "div" }: CardProps) {
  return (
    <Tag className={cn("rounded-2xl border border-line bg-surface p-5 sm:p-6", className)}>
      {children}
    </Tag>
  );
}

export interface SectionHeadingProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function SectionHeading({ title, description, action, className }: SectionHeadingProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export interface PlaceholderProps {
  readonly title: string;
  readonly children?: ReactNode;
  /** Which sprint fills this in — keeps the skeleton honest about its gaps. */
  readonly sprint?: string;
  readonly className?: string;
}

/**
 * An explicit "nothing here yet" panel.
 *
 * Sprint 1's deliverable is an empty shell, and an empty shell that says why it
 * is empty is far easier to review than one that just looks broken.
 */
export function Placeholder({ title, children, sprint, className }: PlaceholderProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-line bg-surface/40 px-5 py-10 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-sm text-sm text-muted">{children}</div> : null}
      {sprint ? (
        <p className="mt-4 inline-block rounded-full border border-line px-2.5 py-1 text-xs text-faint">
          {sprint}
        </p>
      ) : null}
    </div>
  );
}
