<!--
Title format: [new feature] … / [fix] … / [style] …   (see CONTRIBUTING.md)
-->

## What & why

<!-- One or two sentences. Link the TODO.md sprint line this closes. -->

Sprint: <!-- e.g. Sprint 3 — Thu 31 Jul: the upload spine -->

## Checks

- [ ] `bun run check` passes locally (typecheck + lint + unit tests, offline)
- [ ] Diff read line by line before pushing
- [ ] New env vars added to **both** `packages/env/src/schema.ts` and `.env.example`
- [ ] No secrets, no live credentials, nothing that only passes CI with a token
- [ ] Docs updated if this changes an entity, state machine, role or a decision
      (`docs/domain-model.md`, `docs/glossary.md`, a new `docs/adr/NNNN-*.md`)

## Verified how

<!-- Which releasable checkpoint (RC1–RC7) this moves, and what you actually clicked. -->
