"use client";

import { useMutation, useQuery } from "convex/react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ToggleField } from "@/components/ui/toggle-field";
import { appErrorMessage } from "@/lib/app-errors";
import { backendApi, type PhotoChallenge } from "@/lib/convex-api";

export function PhotoChallengeSettings({ eventId }: { readonly eventId: string }) {
  const deck = useQuery(backendApi.photo_challenges.list, { eventId });
  const createChallenge = useMutation(backendApi.photo_challenges.create);
  const setEnabled = useMutation(backendApi.photo_challenges.setEnabled);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || prompt.trim().length === 0) return;
    setPending(true);
    setError(undefined);
    try {
      await createChallenge({ eventId, prompt });
      setPrompt("");
    } catch (cause) {
      setError(appErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function toggle(enabled: boolean) {
    setPending(true);
    setError(undefined);
    try {
      await setEnabled({ eventId, enabled });
    } catch (cause) {
      setError(appErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (deck === undefined) return <p className="mt-4 text-sm text-muted">Loading challenges…</p>;

  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4">
      <ToggleField
        label="Offer photo challenges"
        description="Guests get one personal prompt at a time. Challenges only attach to photos taken after the prompt appears."
        checked={deck.enabled}
        disabled={pending}
        onChange={(enabled) => void toggle(enabled)}
      />
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">
          {deck.activeCount} active · at least {deck.minimumActive} required
        </span>
        <span className="text-faint">Maximum {deck.maximumActive}</span>
      </div>

      <form className="flex gap-2" onSubmit={(event) => void add(event)}>
        <label className="min-w-0 flex-1">
          <span className="sr-only">New photo challenge</span>
          <input
            value={prompt}
            maxLength={120}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Add a challenge…"
            className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-plum focus:ring-2 focus:ring-plum/15"
          />
        </label>
        <Button type="submit" variant="secondary" loading={pending} disabled={!prompt.trim()}>
          Add
        </Button>
      </form>

      {error ? <Callout tone="danger">{error}</Callout> : null}

      <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {deck.challenges.map((challenge) => (
          <li key={challenge.id}>
            <ChallengeRow challenge={challenge} onError={setError} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChallengeRow({
  challenge,
  onError,
}: {
  readonly challenge: PhotoChallenge;
  readonly onError: (message: string | undefined) => void;
}) {
  const update = useMutation(backendApi.photo_challenges.update);
  const setArchived = useMutation(backendApi.photo_challenges.setArchived);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(challenge.prompt);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    onError(undefined);
    try {
      await update({ challengeId: challenge.id, prompt });
      setEditing(false);
    } catch (cause) {
      onError(appErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function archive(archived: boolean) {
    setPending(true);
    onError(undefined);
    try {
      await setArchived({ challengeId: challenge.id, archived });
    } catch (cause) {
      onError(appErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      {editing ? (
        <input
          value={prompt}
          maxLength={120}
          onChange={(event) => setPrompt(event.target.value)}
          className="h-10 w-full rounded-lg border border-line px-2 text-sm text-ink outline-none focus:border-plum"
        />
      ) : (
        <p
          className={
            challenge.status === "archived" ? "text-sm text-faint line-through" : "text-sm text-ink"
          }
        >
          {challenge.prompt}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" variant="secondary" loading={pending} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void archive(challenge.status === "active")}
            >
              {challenge.status === "active" ? "Archive" : "Restore"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
