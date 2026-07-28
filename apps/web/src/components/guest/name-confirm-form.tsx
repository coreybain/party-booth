"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { type FormEvent, useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { appErrorMessage } from "@/lib/app-errors";
import { displayNameSchema, TERMS_ACCEPTANCE_PROMPT, TERMS_VERSION } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";

export interface NameConfirmFormProps {
  /** The name we already have — from Google, or derived from the email address. */
  readonly initialName: string;
  readonly onConfirmed: (name: string) => void;
  readonly submitLabel?: string;
  readonly busy?: boolean;
}

/**
 * The name-confirmation step (PLAN.md → "then name + photo confirmation").
 *
 * Photo confirmation waits for the upload pipeline in Sprint 3; the name does
 * not, because it is the only thing a host has to tell two guests apart in the
 * moderation queue, and the default — the local part of an email address — is
 * frequently wrong ("j.smith82").
 *
 * The write goes through `users.updateProfile`, which is the **one** writer of
 * `users.displayName` — `apps/mobile` uses the same mutation. It used to go
 * through Better Auth's `updateUser` and rely on the `user.onUpdate` trigger to
 * mirror the name across, which worked but left the column with two authors:
 * the guest, and whatever the identity provider last said. Verifying an email
 * fires that trigger, so "Sam" would quietly become "Samantha Smith" again.
 *
 * The mutation is called even when the name is unchanged, because confirming is
 * not only about the string: it stamps `onboardedAt`, which is the only way the
 * backend can tell a name a human chose from one we derived from their email
 * address.
 *
 * Validated against `displayNameSchema` first, so the client and Convex agree on
 * what a name is (1–60 characters, trimmed) before a round trip is spent.
 */
export function NameConfirmForm({
  initialName,
  onConfirmed,
  submitLabel = "That's me",
  busy = false,
}: NameConfirmFormProps) {
  const updateProfile = useMutation(backendApi.users.updateProfile);
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = displayNameSchema.safeParse(name);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "Enter a name.");
        return;
      }

      setPending(true);
      setError(undefined);
      try {
        // Acceptance travels with the confirmation, because this is the one
        // screen every account passes through before it can post anything and
        // Play's UGC policy asks for agreement *before* content is created. The
        // server records it only if it matches the version it publishes.
        await updateProfile({ displayName: parsed.data, acceptedTermsVersion: TERMS_VERSION });
        onConfirmed(parsed.data);
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(false);
      }
    },
    [name, onConfirmed, updateProfile],
  );

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <TextField
        label="Your name"
        name="display-name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(undefined);
        }}
        maxLength={60}
        autoComplete="name"
        autoCapitalize="words"
        enterKeyHint="done"
        hint="This is what the host sees next to your photos."
        error={error}
        disabled={pending || busy}
        autoFocus
      />

      <Button type="submit" size="lg" fullWidth loading={pending || busy}>
        {submitLabel}
      </Button>

      {/*
        The acceptance, next to the button that gives it.
        Play's UGC policy asks for terms that define and prohibit objectionable
        content *and* for the user to have agreed to them; a link in a footer is
        the first half only. Both links open in a new tab so a guest halfway
        through joining a party does not lose their place reading them.
      */}
      <p className="text-center text-xs leading-relaxed text-faint">
        {TERMS_ACCEPTANCE_PROMPT.replace(/\.$/, "")} —{" "}
        <Link
          href="/terms"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          terms
        </Link>{" "}
        and{" "}
        <Link
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          privacy
        </Link>
        .
      </p>
    </form>
  );
}
