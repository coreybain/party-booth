"use client";

import { UserPlusIcon } from "@/components/icons";
import { OrganiserInviteForm } from "@/components/admin/organiser-invite-form";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function OrganiserInviteSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-9 rounded-full px-0 text-muted hover:text-accent"
          aria-label="Invite an organiser"
          title="Invite an organiser"
        >
          <UserPlusIcon size={18} />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Invite an organiser</SheetTitle>
          <SheetDescription>
            Send a single-use invitation link that signs the recipient in and grants organiser
            access. The action and your reason are written to the audit log.
          </SheetDescription>
        </SheetHeader>
        <OrganiserInviteForm layout="sheet" />
      </SheetContent>
    </Sheet>
  );
}
