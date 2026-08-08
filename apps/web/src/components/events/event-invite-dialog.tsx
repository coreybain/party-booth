"use client";

import { InvitePanel } from "@/components/events/invite-panel";
import { QrIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { EventState } from "@/lib/contracts";

export interface EventInviteDialogProps {
  readonly code: string;
  readonly token?: string | undefined;
  readonly version: number;
  readonly state: EventState;
  readonly eventName: string;
}

/** A prominent mobile-friendly shortcut to the host-only join credential. */
export function EventInviteDialog({
  code,
  token,
  version,
  state,
  eventName,
}: EventInviteDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <QrIcon size={17} />
          Show join QR
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Help guests join</DialogTitle>
          <DialogDescription>
            Ask guests to scan this QR code, or give them the six-digit code.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5">
          <InvitePanel
            code={code}
            token={token}
            version={version}
            state={state}
            eventName={eventName}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
