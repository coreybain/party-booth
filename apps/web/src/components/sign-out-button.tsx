"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { isBackendConfigured } from "@/lib/backend";

/**
 * Ends the Better Auth session and returns to the given route.
 *
 * `router.refresh()` matters: the authenticated shells are Server Components
 * that read the session cookie, so the client cache has to be dropped or the
 * user would keep seeing the signed-in shell until a hard reload.
 */
export function SignOutButton({ redirectTo = "/" }: { readonly redirectTo?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      disabled={!isBackendConfigured}
      onClick={() => {
        setPending(true);
        void authClient
          .signOut()
          .catch(() => {
            // A failed sign-out must still clear the UI; the cookie is
            // short-lived and the server re-checks on every request.
          })
          .finally(() => {
            setPending(false);
            router.replace(redirectTo);
            router.refresh();
          });
      }}
    >
      Sign out
    </Button>
  );
}
