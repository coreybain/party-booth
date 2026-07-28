"use client";

import { useAction } from "convex/react";
import { useCallback, useState } from "react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Card, SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TextField } from "@/components/ui/text-field";
import { ORGANISER_INVITE_COPY } from "@/lib/admin/actions";
import { emailSchema } from "@/lib/contracts";
import { adminApi } from "@/lib/convex-api";

/**
 * The only way into the private beta.
 *
 * PLAN.md calls organiser invitation one of the console's three non-negotiable
 * core actions, and TODO.md's rule is "confirmation + reason + immutable audit
 * on **every** action". This form used to have two of the three: the reason was
 * captured inline and `organiser.invited` is on
 * `AUDIT_ACTIONS_REQUIRING_REASON`, but the invitation went out on a single
 * click with nothing between the typed address and the send.
 *
 * So it is now the same two-step every other privileged action takes. The
 * address and the note are collected here; **"Review invitation" hands off to
 * `ConfirmAction`**, which restates the consequences, shows the parsed address
 * back, and keeps the confirm button dead until `adminReasonSchema` accepts the
 * reason. One dialog component rather than a second inline gate, because a
 * bespoke confirmation written in a hurry is how one action ends up without a
 * reason field — which is precisely what happened here.
 *
 * The invitation is claimed by the **address**, not by the link: matching binds
 * on a verified email, so forwarding the message gets somebody else nothing. The
 * form says so, because "just forward it to them" is otherwise the obvious thing
 * for an administrator to suggest.
 */
export function OrganiserInviteForm() {
  const invite = useAction(adminApi.inviteOrganiser);

  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);
  /** The parsed address, once review has started. `undefined` means step one. */
  const [reviewing, setReviewing] = useState<string | undefined>(undefined);

  const review = useCallback(() => {
    setSentTo(undefined);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "That is not an email address.");
      return;
    }
    setEmailError(undefined);
    // The *parsed* address, not the raw field: what is confirmed has to be what
    // is sent, or the dialog is showing one thing and the mutation doing another.
    setReviewing(parsed.data);
  }, [email]);

  const confirm = useCallback(
    async (reason: string) => {
      const target = reviewing;
      if (target === undefined) return;
      await invite({
        email: target,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        reason,
      });
      // Only on success. A rejection leaves the dialog open with the typed
      // reason intact — `ConfirmAction` catches and renders it.
      setSentTo(target);
      setReviewing(undefined);
      setEmail("");
      setNote("");
    },
    [invite, note, reviewing],
  );

  return (
    <Card>
      <SectionHeading
        title="Invite an organiser"
        description="The only way into the private beta. Confirmed, reasoned and recorded, like everything else here."
      />

      <form
        className="mt-4 space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        <TextField
          label="Email address"
          name="organiser-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="them@example.com"
          value={email}
          disabled={reviewing !== undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError(undefined);
          }}
          {...(emailError === undefined ? {} : { error: emailError })}
          hint="They become an organiser the first time they sign in with this exact address, verified. Forwarding the email gets somebody else nothing."
        />

        <TextField
          label="Note (optional)"
          name="organiser-note"
          value={note}
          maxLength={280}
          disabled={reviewing !== undefined}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          hint="Goes in the email they receive. Not in the audit log."
        />

        {sentTo === undefined ? null : (
          <Callout tone="success" live="polite">
            Invitation sent to {sentTo}. It is good for fourteen days.
          </Callout>
        )}

        {reviewing === undefined ? (
          <Button type="submit" disabled={email.trim().length === 0}>
            {ORGANISER_INVITE_COPY.label}
          </Button>
        ) : null}
      </form>

      {reviewing === undefined ? null : (
        <ConfirmAction
          copy={ORGANISER_INVITE_COPY}
          subject={reviewing}
          onConfirm={confirm}
          onCancel={() => {
            setReviewing(undefined);
          }}
        />
      )}
    </Card>
  );
}
