"use client";

import { useAction } from "convex/react";
import { useCallback, useState } from "react";

import { Card, SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TextField } from "@/components/ui/text-field";
import { appErrorMessage } from "@/lib/app-errors";
import {
  checkReason,
  confirmEnabled,
  REASON_MAX_LENGTH,
  reasonMessage,
} from "@/lib/admin/reason-gate";
import { emailSchema } from "@/lib/contracts";
import { adminApi } from "@/lib/convex-api";

/**
 * The only way into the private beta.
 *
 * PLAN.md calls organiser invitation one of the console's three non-negotiable
 * core actions, and `organiser.invited` is on `AUDIT_ACTIONS_REQUIRING_REASON`
 * even though nothing about it is destructive — it is the action that grows the
 * beta, and therefore the one somebody will ask about later. So it carries the
 * same reason gate every lock and deletion does, inline rather than behind a
 * dialog because there is nothing here to confirm *away* from.
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
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);

  const gate = checkReason(reason);
  const enabled = confirmEnabled(gate, pending) && email.trim().length > 0;

  const submit = useCallback(async () => {
    setSentTo(undefined);
    setError(undefined);

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "That is not an email address.");
      return;
    }
    setEmailError(undefined);

    setPending(true);
    try {
      await invite({
        email: parsed.data,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        reason: gate.trimmed,
      });
      setSentTo(parsed.data);
      setEmail("");
      setNote("");
      setReason("");
      setTouched(false);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [email, gate.trimmed, invite, note]);

  const message = reasonMessage(gate, touched);

  return (
    <Card>
      <SectionHeading
        title="Invite an organiser"
        description="The only way into the private beta. Recorded with a reason, like everything else here."
      />

      <form
        className="mt-4 space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
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
          onChange={(event) => {
            setNote(event.target.value);
          }}
          hint="Goes in the email they receive. Not in the audit log."
        />

        <div>
          <label
            htmlFor="organiser-invite-reason"
            className="mb-1.5 block text-sm font-medium text-muted"
          >
            Why are you inviting them?
          </label>
          <textarea
            id="organiser-invite-reason"
            rows={2}
            value={reason}
            maxLength={REASON_MAX_LENGTH + 40}
            disabled={pending}
            onChange={(event) => {
              setReason(event.target.value);
              setTouched(true);
            }}
            aria-invalid={message === undefined ? undefined : true}
            aria-describedby="organiser-invite-reason-hint"
            className={`w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-faint ${
              message === undefined ? "border-line hover:border-line-strong" : "border-danger"
            }`}
            placeholder="Running the launch party on 5 August; asked for by Corey."
          />
          <p
            id="organiser-invite-reason-hint"
            className={`mt-1.5 text-sm ${message === undefined ? "text-faint" : "text-danger"}`}
          >
            {message ??
              `Written to the audit log against your account. ${gate.remaining} characters left.`}
          </p>
        </div>

        {error === undefined ? null : (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        )}

        {sentTo === undefined ? null : (
          <Callout tone="success" live="polite">
            Invitation sent to {sentTo}. It is good for fourteen days.
          </Callout>
        )}

        <Button type="submit" loading={pending} disabled={!enabled}>
          Send invitation
        </Button>
      </form>
    </Card>
  );
}
