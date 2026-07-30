# Architecture decision records

Short documents recording **why** the architecture is the shape it is, so a decision is argued once
and then cited. Numbered sequentially, never renumbered, never deleted — a decision that turns out
to be wrong gets a **new** ADR that supersedes the old one, and the old one is marked accordingly.

## Format

Copy [`0000-template.md`](0000-template.md). Every ADR has: Status, Context, Decision, Consequences,
Alternatives considered. Keep it to a page. Past tense for what happened, present for what holds.

Statuses: **Proposed** · **Accepted** · **Superseded by NNNN** · **Deprecated**.

## Write one when

- The decision is expensive to reverse (a provider, a region, a runtime, a data shape).
- You will be asked "why not X?" more than once.
- You are deliberately accepting a downside.

Do **not** write one for a library choice you would change in an afternoon.

## Index

| #                                                  | Title                                                  | Status             | Date        |
| -------------------------------------------------- | ------------------------------------------------------ | ------------------ | ----------- |
| [0001](0001-monorepo-runtime.md)                   | Monorepo, package manager and runtime baseline         | Superseded by 0011 | 28 Jul 2026 |
| [0002](0002-storage-region-adapter.md)             | Per-event `storageRegion` behind an adapter            | Accepted           | 28 Jul 2026 |
| [0004](0004-private-upload-pipeline.md)            | Private upload pipeline and grant model                | Accepted           | 31 Jul 2026 |
| [0005](0005-moderation-model.md)                   | Moderation model, actions, reports and blocks          | Accepted           | 1 Aug 2026  |
| [0008](0008-client-produced-derivatives.md)        | Client-produced derivatives as file roles              | Accepted           | 1 Aug 2026  |
| [0009](0009-verified-uploads-and-real-deletion.md) | Verified uploads, reconciled reads, real deletion      | Accepted           | 1 Aug 2026  |
| [0010](0010-lock-sweep-and-push-adapter.md)        | Owner-derived lock freeze, Expo push behind an adapter | Accepted           | 2 Aug 2026  |
| [0011](0011-bun-package-manager.md)                | Bun 1.3 as package manager and script runner           | Accepted           | 30 Jul 2026 |

## Planned

Called for by [`PLAN.md`](../../PLAN.md#docs--conventions), to be written by the sprint that makes
the decision real rather than pre-empted here:

| #    | Title                              | Owner sprint |
| ---- | ---------------------------------- | ------------ |
| 0003 | Better Auth on Convex for identity | Sprint 1     |
| 0006 | Offline capture queue and delivery | Sprint 3–4   |
| 0007 | Data lifecycle, deletion and purge | Post-launch  |
