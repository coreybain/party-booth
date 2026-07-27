# PartyBooth docs

Reference material. The two planning documents at the repo root stay authoritative for **scope and
sequencing**; these files carry the **durable** description of the product and its domain.

| Document                             | Answers                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| [`product-spec.md`](product-spec.md) | What PartyBooth is, who uses it, what ships on 5 Aug and what does not |
| [`domain-model.md`](domain-model.md) | Entities, roles, permissions, state machines, `storageRegion`          |
| [`glossary.md`](glossary.md)         | One agreed word per concept, so code and conversation match            |
| [`adr/`](adr/README.md)              | Architecture decision records — why the shape is the shape             |

Root documents:

- [`../PLAN.md`](../PLAN.md) — the spec: launch scope, decisions log, day-by-day schedule, risks.
- [`../TODO.md`](../TODO.md) — the working tracker, one sprint per day, releasable checkpoints.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — commit convention, sprint cadence, the CI gate.
- [`../README.md`](../README.md) — toolchain, layout, commands, conventions.

## What lives where

These docs describe intent. They are **not** the source of truth for anything a machine checks:

| Question                     | Source of truth                               |
| ---------------------------- | --------------------------------------------- |
| Exact table and field shapes | `packages/backend/convex/schema.ts`           |
| Exact validation rules       | `packages/contracts/src/**` (zod schemas)     |
| Who may do what, precisely   | `packages/contracts/src/permissions*`         |
| Every environment variable   | `.env.example` + `packages/env/src/schema.ts` |

When they disagree, the code wins and the doc is a bug. Fix it in the same PR.

## Status of these documents

Seeded during Sprint 1 from `PLAN.md`. Sections marked **(Sprint N)** are placeholders to be filled
by the sprint that builds the thing — deliberately empty rather than speculatively wrong.
