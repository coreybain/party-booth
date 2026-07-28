"use client";

import { useEffect, useRef, useState } from "react";

import { CheckIcon, CopyIcon } from "@/components/icons";
import { Button, type ButtonProps } from "@/components/ui/button";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  readonly value: string;
  readonly label: string;
  /** Announced and shown for two seconds after a successful copy. */
  readonly copiedLabel?: string;
}

/**
 * Copy to clipboard, with the confirmation that makes it believable.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused
 * outright, so a failure falls back to selecting nothing and simply not
 * claiming success — the value is always visible on screen next to the button,
 * which is the real fallback.
 */
export function CopyButton({ value, label, copiedLabel = "Copied", ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            if (timer.current !== undefined) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setCopied(false);
            }, 2000);
          })
          .catch(() => {
            // Nothing to say: the value is on screen and can be selected.
          });
      }}
      {...props}
    >
      {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  );
}
