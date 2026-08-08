# 0012. Photo challenge assignments are server-backed snapshots

- **Status:** Accepted
- **Date:** 8 Aug 2026
- **Sprint:** Post-launch product iteration

## Context

Photo challenges have two conflicting needs. A guest's current prompt must follow their account
between the web and native clients and must not repeat until the active deck is exhausted. At the
same time, a host must be free to edit or archive the deck during a party without changing the
meaning of a photo somebody already took. Upload retries may also happen after the guest has moved
on to another prompt.

A client-selected prompt string would be easy to build, but it would let a modified client attach
arbitrary text to media. Reading the live prompt row at upload time would be authoritative but
would rewrite history when a host edits it.

## Decision

Convex issues an immutable `photoChallengeAssignments` row containing the event, account,
challenge id, prompt snapshot, cycle and status. A bounded `photoChallengeProgress` row holds the
current assignment and the challenge ids seen in the current cycle. Selection uses cryptographic
random bytes through an injectable pure helper; a new cycle begins only after all currently active
prompts have been seen.

The client holds a newly captured photo for an explicit confirmation. Choosing **Use challenge**
resolves the assignment against that capture id before the durable upload begins. The upload grant
accepts the assignment id, verifies the event, user, `used` state and capture id, then copies the
trusted prompt snapshot onto the grant and media row. Videos and library imports cannot carry an
assignment. **Send without challenge** resolves and advances the prompt without attaching it;
**Retake** leaves the current assignment in place.

New events receive the starter deck and enable challenges. Existing event rows have no flag and
therefore read as disabled. Owners and co-hosts manage the deck. At least three active prompts are
required to enable it, with a maximum of fifty.

## Consequences

- A prompt is consistent across devices and survives retries, host edits and prompt advancement.
- The media row contains presentation copy, but only after the server validates its assignment.
- Assignments accumulate as lightweight history rows. The progress row stays bounded to fifty ids.
- Host edits affect future assignments only; assigned snapshots are deliberately immutable.
- The camera waits for one extra guest decision when challenges are visible. Guests can hide the
  feature for the current client session with **Not now**.

## Alternatives considered

| Option                                                | Why not                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Pick and store prompts only on the client             | Cross-device state drifts, repeats cannot be enforced, and arbitrary prompt text reaches media. |
| Read the current prompt row when upload completes     | A host edit would silently change the challenge attached to a photo already taken.              |
| Store only the prompt on media after capture          | There is no durable proof that the server issued that prompt to that account and capture.       |
| Auto-attach the visible prompt when the shutter fires | It removes the guest's choice and makes accidental captures consume a challenge.                |
