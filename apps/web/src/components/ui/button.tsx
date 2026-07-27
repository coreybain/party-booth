import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent hover:brightness-110 active:brightness-95 disabled:hover:brightness-100",
  secondary: "bg-raised text-ink border border-line hover:border-line-strong",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-raised",
  danger: "bg-transparent text-danger border border-danger/40 hover:bg-danger/10",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  // 3rem tall: comfortably tappable one-handed on a phone in a dark room.
  lg: "h-12 px-5 text-base gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  /** Shows a spinner and blocks input without changing the button's width. */
  readonly loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center rounded-xl font-medium",
        "transition-[filter,background-color,border-color,opacity] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      <span className={cn("inline-flex items-center gap-2", loading && "invisible")}>
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      ) : null}
    </button>
  );
}

function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="animate-spin">
      <circle
        cx="9"
        cy="9"
        r="7"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
        fill="none"
      />
      <path
        d="M16 9a7 7 0 0 0-7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
