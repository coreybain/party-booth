"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { BackendGate } from "@/components/backend-gate";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi } from "@/lib/convex-api";

/**
 * The control on `/account/deletion` — the web route Play's policy requires.
 *
 * The identity verification is the sign-in itself, and that is a deliberate
 * design rather than a shortcut. `users.requestAccountDeletion` acts on the
 * signed-in account and takes no subject argument, so there is no field on this
 * page naming an address and therefore no way to aim it at somebody else. A form
 * that accepted an email would need its own verification round trip and would be
 * a new way to harass a stranger; a sign-in is a verification the product
 * already has.
 *
 * Everything above this component renders with no backend at all, which is what
 * lets a signed-out visitor — and an empty-environment `next build` — read the
 * whole explanation. Only the button needs Convex.
 */
export function AccountDeletionRequest() {
  return (
    <BackendGate
      fallback={
        <Callout title="Deletion is unavailable on this deployment">
          This copy of PartyBooth has no backend configured. Use the app, or write to the address on
          the <Link href="/privacy">privacy page</Link>.
        </Callout>
      }
    >
      <DeletionControl />
    </BackendGate>
  );
}

function DeletionControl() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(backendApi.users.currentUser, isAuthenticated ? {} : "skip");
  const requestDeletion = useMutation(backendApi.users.requestAccountDeletion);

  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [scheduledAt, setScheduledAt] = useState<number | undefined>(undefined);

  const submit = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      const result = await requestDeletion({ reason: "Requested from the web deletion page." });
      setScheduledAt(result.scheduledAt ?? undefined);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [requestDeletion]);

  if (isLoading) {
    return (
      <p className="text-sm text-faint" role="status">
        Checking whether you are signed in…
      </p>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">Request deletion</h2>
        <p>
          Sign in first. That is how we know the request is yours — this page never asks for
          somebody else&rsquo;s address, so it cannot be aimed at anybody but you.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex h-11 select-none items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-on-accent"
        >
          Sign in to continue
        </Link>
      </section>
    );
  }

  if (scheduledAt !== undefined || me?.accountState === "deletionScheduled") {
    return (
      <Callout tone="success" title="Your account is scheduled for deletion" live="polite">
        Access has already ended. Everything is erased thirty days from the request. If you change
        your mind before then, reply to any email we have sent you and we will cancel it.
      </Callout>
    );
  }

  if (me?.accountState === "deleted") {
    return (
      <Callout tone="info" title="This account has already been erased">
        There is nothing left to delete.
      </Callout>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-ink">Request deletion</h2>
      <p>
        Signed in as <span className="text-ink">{me?.email ?? "…"}</span>. This deletes{" "}
        <em>this</em> account.
      </p>

      {error === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      )}

      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            loading={pending}
            onClick={() => {
              void submit();
            }}
          >
            Yes, delete my account
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="danger"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Delete my account
        </Button>
      )}
    </section>
  );
}
