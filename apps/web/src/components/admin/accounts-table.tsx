"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { AdminSearch, AdminTableShell, EmptyRow } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import {
  ACCOUNT_ACTION_COPY,
  accountActionsFor,
  accountStateNote,
  type AdminAccountAction,
} from "@/lib/admin/actions";
import { formatBytes, type AccountState } from "@/lib/contracts";
import { adminApi, type AdminAccount } from "@/lib/convex-api";
import type { MediaTone } from "@/lib/media-view";

/**
 * Accounts: state, roles, events owned, storage — and the four actions PLAN.md
 * names, each behind a reason-gated confirmation.
 *
 * There are deliberately **no thumbnails anywhere in this console**, here or on
 * the events table. `globalAdmin` has no `media.*` capability at all — an admin
 * can count a party's photographs and can never look at one — so this table
 * shows `mediaCount` and `storageBytes` and no image tag exists to render.
 *
 * Which actions a row gets is read off `accountStateMachine` in
 * `src/lib/admin/actions.ts`, not written here. A `switch` in this component
 * would be a second copy of a table Convex already owns, and the way that fails
 * is a button whose only outcome is an `invalidState` error.
 */
export function AccountsTable() {
  const [search, setSearch] = useState("");
  const accounts = useQuery(adminApi.accounts, search.trim().length > 0 ? { search } : {});

  return (
    <AdminTableShell
      title="Accounts"
      description="State, roles, storage. No media, ever — an admin can count photographs and cannot look at one."
      search={
        <AdminSearch
          label="Search accounts"
          placeholder="Email or name"
          value={search}
          onChange={setSearch}
        />
      }
      total={accounts?.total}
      shown={accounts?.items.length}
    >
      {accounts === undefined ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : accounts.items.length === 0 ? (
        <EmptyRow>
          {search.trim().length > 0 ? "Nothing matches that." : "No accounts yet."}
        </EmptyRow>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.items.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}
    </AdminTableShell>
  );
}

const STATE_TONES: Record<AccountState, MediaTone> = {
  active: "positive",
  locked: "danger",
  deletionScheduled: "warning",
  deleted: "neutral",
};

const STATE_LABELS: Record<AccountState, string> = {
  active: "Active",
  locked: "Locked",
  deletionScheduled: "Deleting",
  deleted: "Deleted",
};

function AccountRow({ account }: { readonly account: AdminAccount }) {
  const [open, setOpen] = useState<AdminAccountAction | undefined>(undefined);
  const note = accountStateNote(account);
  const actions = accountActionsFor(account.accountState);

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{account.displayName}</span>
            <StatusChip
              label={STATE_LABELS[account.accountState]}
              tone={STATE_TONES[account.accountState]}
            />
            {account.isGlobalAdmin ? <StatusChip label="Admin" tone="progress" /> : null}
            {account.isOrganiser ? <StatusChip label="Organiser" /> : null}
            {account.emailVerified ? null : <StatusChip label="Unverified" tone="warning" />}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted">{account.email}</p>
          {note === undefined ? null : <p className="mt-0.5 text-sm text-faint">{note}</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={ACCOUNT_ACTION_COPY[action].tone === "danger" ? "danger" : "secondary"}
              onClick={() => {
                setOpen((current) => (current === action ? undefined : action));
              }}
            >
              {ACCOUNT_ACTION_COPY[action].label}
            </Button>
          ))}
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <Figure label="Events owned" value={account.ownedEvents} />
        <Figure label="Parties joined" value={account.memberships} />
        <Figure label="Submissions" value={account.mediaCount} />
        <Figure label="Storage" value={formatBytes(account.storageBytes)} />
        <Figure label="Push devices" value={account.pushDevices} />
      </dl>

      {open === undefined ? null : (
        <AccountActionDialog
          account={account}
          action={open}
          onDone={() => {
            setOpen(undefined);
          }}
        />
      )}
    </li>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-faint">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/**
 * One dialog, four mutations.
 *
 * Each of them takes `{ userId, reason }` and writes an audit row; the only
 * thing that varies is which one and what the copy says, so the dispatch is a
 * `switch` on the action rather than four near-identical components.
 */
function AccountActionDialog({
  account,
  action,
  onDone,
}: {
  readonly account: AdminAccount;
  readonly action: AdminAccountAction;
  readonly onDone: () => void;
}) {
  const lock = useMutation(adminApi.lockAccount);
  const unlock = useMutation(adminApi.unlockAccount);
  const scheduleDeletion = useMutation(adminApi.scheduleAccountDeletionFor);
  const restore = useMutation(adminApi.restoreAccount);

  const run = useCallback(
    async (reason: string) => {
      const args = { userId: account.id, reason };
      switch (action) {
        case "lock":
          await lock(args);
          break;
        case "unlock":
          await unlock(args);
          break;
        case "scheduleDeletion":
          await scheduleDeletion(args);
          break;
        case "restore":
          await restore(args);
          break;
      }
      onDone();
    },
    [account.id, action, lock, onDone, restore, scheduleDeletion, unlock],
  );

  return (
    <ConfirmAction
      copy={ACCOUNT_ACTION_COPY[action]}
      subject={`${account.displayName} · ${account.email}`}
      onConfirm={run}
      onCancel={onDone}
      blocked={
        action === "lock" && account.isGlobalAdmin
          ? "This account is on the admin allowlist. Locking it will not remove it from the allowlist — do that in the environment first, or it can unlock itself."
          : undefined
      }
    />
  );
}
