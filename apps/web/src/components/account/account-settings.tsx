"use client";

import { useMutation, useQuery } from "convex/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { AccountDeletionRequest } from "@/components/account/account-deletion-request";
import { AuthenticatedBackendGate } from "@/components/backend-gate";
import { BackendNotConfigured } from "@/components/backend-not-configured";
import { Card, SectionHeading } from "@/components/layout/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TextField } from "@/components/ui/text-field";
import { appErrorMessage } from "@/lib/app-errors";
import { authClient } from "@/lib/auth-client";
import { backendApi, type CurrentUser } from "@/lib/convex-api";
import { displayNameSchema } from "@/lib/contracts";

interface LinkedAccount {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  apple: "Apple",
  google: "Google",
};

/**
 * Account-level settings.
 *
 * Event settings deliberately live on each event. This page owns the person:
 * the name PartyBooth displays, authentication methods and account lifecycle.
 */
export function AccountSettings() {
  return (
    <AuthenticatedBackendGate fallback={<BackendNotConfigured />}>
      <AccountSettingsLive />
    </AuthenticatedBackendGate>
  );
}

function AccountSettingsLive() {
  const me = useQuery(backendApi.users.currentUser, {});

  if (me === undefined) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <span className="sr-only">Loading your account settings…</span>
        <div className="h-48 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
        <div className="h-56 animate-pulse rounded-2xl bg-raised" aria-hidden="true" />
      </div>
    );
  }

  if (me === null) {
    return (
      <Callout tone="warning">
        Your session has ended. Sign in again before changing account settings.
      </Callout>
    );
  }

  return (
    <div className="space-y-4">
      <Card as="section">
        <SectionHeading
          title="Profile"
          description="The name hosts and guests see beside your activity."
        />
        <ProfileForm key={me.displayName} user={me} />
      </Card>

      <Card as="section">
        <SectionHeading
          title="Sign-in & connections"
          description="PartyBooth uses passwordless email codes and optional social accounts."
        />
        <SignInConnections user={me} />
      </Card>

      <Card as="section" className="border-danger/35">
        <SectionHeading
          title="Deactivate or delete account"
          description="Deletion deactivates the account immediately and permanently erases its data after thirty days."
        />
        <div className="mt-4 border-t border-line pt-4 text-sm leading-6 text-muted">
          <AccountDeletionRequest />
        </div>
      </Card>
    </div>
  );
}

function ProfileForm({ user }: { readonly user: CurrentUser }) {
  const updateProfile = useMutation(backendApi.users.updateProfile);
  const [name, setName] = useState(user.displayName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = displayNameSchema.safeParse(name);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "Enter a name.");
        return;
      }

      setPending(true);
      setError(undefined);
      setSaved(false);
      try {
        await updateProfile({ displayName: parsed.data });
        setName(parsed.data);
        setSaved(true);
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPending(false);
      }
    },
    [name, updateProfile],
  );

  return (
    <form
      className="mt-4 max-w-xl space-y-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextField
        label="Display name"
        name="display-name"
        value={name}
        maxLength={60}
        autoComplete="name"
        autoCapitalize="words"
        hint="Used on hosted events, submissions and moderation activity."
        error={error}
        disabled={pending}
        onChange={(event) => {
          setName(event.target.value);
          setError(undefined);
          setSaved(false);
        }}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending} disabled={name.trim() === user.displayName}>
          Save profile
        </Button>
        {saved ? (
          <span className="text-sm text-positive" role="status">
            Profile saved.
          </span>
        ) : null}
      </div>
    </form>
  );
}

function SignInConnections({ user }: { readonly user: CurrentUser }) {
  const [accounts, setAccounts] = useState<readonly LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadAccounts = useCallback(async () => {
    try {
      const result = await authClient.listAccounts();
      if (result.error) throw result.error;
      setAccounts(result.data ?? []);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void authClient
      .listAccounts()
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setError(appErrorMessage(result.error));
          return;
        }
        setAccounts(result.data ?? []);
      })
      .catch((caught: unknown) => {
        if (active) setError(appErrorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const disconnect = useCallback(
    async (account: LinkedAccount) => {
      setPendingProvider(account.providerId);
      setError(undefined);
      try {
        const result = await authClient.unlinkAccount({
          providerId: account.providerId,
          accountId: account.accountId,
        });
        if (result.error) throw result.error;
        await loadAccounts();
      } catch (caught) {
        setError(appErrorMessage(caught));
      } finally {
        setPendingProvider(undefined);
      }
    },
    [loadAccounts],
  );

  const connectGoogle = useCallback(async () => {
    setPendingProvider("google");
    setError(undefined);
    try {
      const result = await authClient.linkSocial({
        provider: "google",
        callbackURL: "/settings",
        errorCallbackURL: "/settings?connection=failed",
      });
      if (result.error) throw result.error;
    } catch (caught) {
      setError(appErrorMessage(caught));
      setPendingProvider(undefined);
    }
  }, []);

  const socialAccounts = accounts.filter(
    (account) => account.providerId !== "credential" && account.providerId !== "email-otp",
  );
  const googleConnected = socialAccounts.some((account) => account.providerId === "google");

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-canvas/30 p-4">
        <div>
          <p className="text-sm font-medium text-ink">Email code</p>
          <p className="mt-0.5 text-sm text-muted">{user.email}</p>
          <p className="mt-1 text-xs text-faint">
            {user.emailVerified ? "Verified" : "Verification pending"} · No password to remember or
            change.
          </p>
        </div>
        <span className="rounded-full border border-positive/35 bg-positive/10 px-2.5 py-1 text-xs font-medium text-positive">
          Primary
        </span>
      </div>

      {loading ? (
        <div className="h-20 animate-pulse rounded-xl bg-raised" role="status">
          <span className="sr-only">Loading connected accounts…</span>
        </div>
      ) : (
        <>
          {socialAccounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-canvas/30 p-4"
            >
              <div>
                <p className="text-sm font-medium text-ink">
                  {PROVIDER_LABELS[account.providerId] ?? account.providerId}
                </p>
                <p className="mt-0.5 text-sm text-muted">Connected sign-in account</p>
              </div>
              <Button
                variant="danger"
                size="sm"
                loading={pendingProvider === account.providerId}
                disabled={pendingProvider !== undefined}
                onClick={() => {
                  void disconnect(account);
                }}
              >
                Disconnect
              </Button>
            </div>
          ))}

          {!googleConnected ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-line p-4">
              <div>
                <p className="text-sm font-medium text-ink">Google</p>
                <p className="mt-0.5 text-sm text-muted">
                  Add another secure way to access this account.
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={pendingProvider === "google"}
                disabled={pendingProvider !== undefined}
                onClick={() => {
                  void connectGoogle();
                }}
              >
                Connect Google
              </Button>
            </div>
          ) : null}
        </>
      )}

      {error === undefined ? null : (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      )}
    </div>
  );
}
