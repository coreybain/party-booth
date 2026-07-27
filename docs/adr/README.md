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

| #                                      | Title                                          | Status   | Date        |
| -------------------------------------- | ---------------------------------------------- | -------- | ----------- |
| [0001](0001-monorepo-runtime.md)       | Monorepo, package manager and runtime baseline | Accepted | 28 Jul 2026 |
| [0002](0002-storage-region-adapter.md) | Per-event `storageRegion` behind an adapter    | Accepted | 28 Jul 2026 |

## Planned

Called for by [`PLAN.md`](../../PLAN.md#docs--conventions), to be written by the sprint that makes
the decision real rather than pre-empted here:

| #    | Title                                   | Owner sprint |
| ---- | --------------------------------------- | ------------ |
| 0003 | Better Auth on Convex for identity      | Sprint 1     |
| 0004 | Private upload pipeline and grant model | Sprint 3     |
| 0005 | Moderation model and modes              | Sprint 4     |
| 0006 | Offline capture queue and delivery      | Sprint 3–4   |
| 0007 | Data lifecycle, deletion and purge      | Post-launch  |
