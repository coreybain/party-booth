"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import { TERMS_ACCEPTANCE_PROMPT, TERMS_VERSION } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";

/**
 * Recovery step for an established web account that predates the current terms.
 *
 * New accounts accept beside their name confirmation. An existing member can
 * bypass that join step, though, which used to leave co-hosts and returning
 * guests able to open the camera while Convex correctly refused every upload
 * grant with `termsNotAccepted`. Keep the refusal at the trust boundary and
 * give those accounts the missing way to satisfy it before the picker opens.
 */
export function TermsAcceptance() {
  const acceptTerms = useMutation(backendApi.users.acceptTerms);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const accept = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await acceptTerms({ version: TERMS_VERSION });
      // `users.currentUser` is reactive. The parent replaces this prompt with
      // the capture controls as soon as the accepted version reaches it.
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [acceptTerms]);

  return (
    <div className="space-y-4">
      <Callout tone="info" title="Review the current PartyBooth terms">
        <p>{TERMS_ACCEPTANCE_PROMPT}</p>
        <p className="mt-2">
          The rules cover objectionable content, other people&apos;s privacy, reporting and
          blocking. Your name and party access will not change.
        </p>
      </Callout>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/terms" target="_blank" rel="noreferrer" className="sm:flex-1">
          <Button variant="secondary" size="lg" fullWidth disabled={pending}>
            Read the current terms
          </Button>
        </Link>
        <Button
          size="lg"
          fullWidth
          loading={pending}
          className="sm:flex-1"
          onClick={() => {
            void accept();
          }}
        >
          Agree and continue
        </Button>
      </div>

      {error !== undefined ? (
        <Callout tone="danger" title="Couldn't record your agreement" live="assertive">
          {error}
        </Callout>
      ) : null}
    </div>
  );
}
