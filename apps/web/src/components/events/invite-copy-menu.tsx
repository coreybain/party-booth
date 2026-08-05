"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import { CheckIcon, ChevronDownIcon, CopyIcon, QrIcon, XIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  copyAllInviteDetails,
  copyInviteQr,
  copyInviteText,
  inviteCopyMenuItems,
  type InviteClipboardDetails,
  type InviteCopyAction,
} from "@/lib/invite-clipboard";

export interface InviteCopyMenuProps {
  readonly eventName: string;
  readonly code: string;
  readonly groupedCode: string;
  readonly url?: string | undefined;
}

export function InviteCopyMenu({ eventName, code, groupedCode, url }: InviteCopyMenuProps) {
  const [feedback, setFeedback] = useState<
    { readonly message: string; readonly succeeded: boolean } | undefined
  >(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const items = inviteCopyMenuItems(url !== undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  function showFeedback(message: string, succeeded: boolean) {
    setFeedback({ message, succeeded });
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setFeedback(undefined);
    }, 2000);
  }

  async function copy(action: InviteCopyAction, copiedLabel: string) {
    try {
      if (action === "code") {
        await copyInviteText(code);
      } else if (url !== undefined && action === "link") {
        await copyInviteText(url);
      } else if (url !== undefined && action === "qr") {
        await copyInviteQr(url);
      } else if (url !== undefined) {
        const details: InviteClipboardDetails = { eventName, groupedCode, url };
        const result = await copyAllInviteDetails(details);
        showFeedback(result === "rich" ? copiedLabel : "Text copied", true);
        return;
      } else {
        return;
      }
      showFeedback(copiedLabel, true);
    } catch {
      showFeedback("Couldn’t copy", false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="md" aria-label="Copy invite options">
          {feedback === undefined ? (
            <CopyIcon size={16} />
          ) : feedback.succeeded ? (
            <CheckIcon size={16} />
          ) : (
            <XIcon size={16} />
          )}
          <span aria-live="polite">{feedback?.message ?? "Copy"}</span>
          <ChevronDownIcon size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {items.map((item, index) => (
          <Fragment key={item.action}>
            {item.action === "all" && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              className="min-h-11 gap-2.5"
              onSelect={() => {
                void copy(item.action, item.copiedLabel);
              }}
            >
              {item.action === "qr" ? <QrIcon size={17} /> : <CopyIcon size={17} />}
              {item.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
