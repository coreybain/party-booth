# PartyBooth — Refined Plan (Launch: 5 August 2026)

> **Status — end of Mon 28 Jul.** Sprints 1–5 (D1–D5 in the schedule below) are **code-complete, audited and merged on `main`** — built in one day by multi-agent workflows (Opus builders, GPT‑5.6 cross-audit, Fable final gate per sprint), five days ahead of the calendar. 2,071 tests; typecheck/lint/build/export all green with an empty environment; 45 commits. **No releasable checkpoint is verified yet** — RC1–RC5 are blocked solely on owner setup (accounts, env vars, deploys, devices), consolidated as the phased checklist at the bottom of `TODO.md`. Remaining build work: Sprint 6 (Playwright + security spot-checks + polish + dress rehearsal) and Sprint 7 (freeze & stage). Notable scope deltas vs this plan, all recorded in TODO.md/ADRs: derivatives are client-produced (ADR 0008), demo-login env vars are `DEMO_LOGIN_*` (three, incl. a required expiry), and the admin console shipped with nothing cut.

## The one constraint that shapes everything

A real party with 10–50 guests happens on **Tuesday 5 August 2026 — 8 days from 28 July**. Every decision below is sequenced against that date. The original five-milestone plan is re-cut into **Launch scope** (must work at the party) and **Post-launch scope** (everything else, unchanged in intent).

The guaranteed guest path is **mobile web**. The iOS and Android apps are built and submitted as if they will make it, but the party must not depend on App Review.

## Summary

TypeScript/Bun Turborepo:

- `apps/web`: Next.js site on Vercel — organiser console, global-admin console, **guest mobile-web capture**, and the join/deep-link fallback.
- `apps/mobile`: Expo dev-build app, iOS 17+ / Android 10+, clean camera (no effects at launch).
- Shared packages: Convex backend, contracts/schemas, config, jobs.
- Providers: Convex (backend + reactivity), Better Auth on Convex (identity), UploadThing private storage (paid plan), Resend (email), Sentry. Deferred to post-launch: OpenAI moderation, Trigger.dev exports, Banuba, PostHog dashboards.

## Decisions log (from grilling session, 28 Jul 2026)

| Topic                | Decision                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage region model | Per-**event** `storageRegion` field in schema from day one; beta allows a single value. No picker UI yet.                                                                                                                      |
| Beta region          | **UploadThing `pdx1` (Portland)** — confirmed available in dashboard (docs region list is stale). Paid plan; **default ACL set to Private at app creation**.                                                                   |
| Convex region        | **US East (N. Virginia)**. Note: ~60 ms from pdx1; only affects server-side processing, acceptable. Region is immutable per deployment — revisit only via export/import.                                                       |
| Multi-region future  | Via UploadThing "dynamic region selection" (private beta) or one-app-per-region; hidden behind a storage adapter that reads `event.storageRegion`. Files never migrate on region change.                                       |
| Aug 5 clients        | iOS + Android apps built and submitted immediately; **mobile-web guest capture built in parallel as the guaranteed path**.                                                                                                     |
| Store accounts       | Apple Developer active. **No established Play account** → Android ships via Play **internal-testing link** (instant); Play production waits out the 14-day closed-testing rule post-launch.                                    |
| Camera               | **Clean camera only** at launch (tap photo / hold video, flash, flip, orientation). Banuba post-launch; if Banuba procurement/trial fails, fall back to simple non-face filters (vision-camera + Skia) and defer face effects. |
| Web guest auth       | **Google sign-in + six-digit email OTP** (same OTP infra as organisers). Sign in with Apple is app-only.                                                                                                                       |
| Launch keeps         | Video upload, co-hosts, **full admin console**, push notifications, invite rotation, manual moderation.                                                                                                                        |
| Launch defers        | AI moderation, ZIP exports (Trigger.dev), 30-day purge automation, Banuba/effects, PostHog dashboards, load testing at 250 guests.                                                                                             |
| Test bar             | Focused: unit tests (permissions, state transitions, grant validation), one Playwright happy path, 2-physical-phone manual pass, signed-URL/grant expiry spot-check, **dress-rehearsal party ~3 Aug**.                         |

## Product and domain model

Unchanged from the original plan except where noted. In brief:

### Identity and roles

- Organisers: six-digit email OTP on web (10-min expiry, five attempts, 60-s resend cooldown).
- Guests in app: Apple or Google sign-in, then name + photo confirmation. Verified-email matching unlocks organiser/co-host features; Apple private-relay users can verify an organiser email via OTP.
- **Guests on web: Google sign-in or email OTP** (no Apple web OAuth).
- Global admins: separate `/admin` OTP login with server-side allowlist.
- Roles: `globalAdmin`, event `owner`, `cohost`, `guest`. Co-host powers as originally specified.
- Private beta remains invitation-only, global English, 18+.

### Entities and states

As originally specified (users, invitations, events, memberships, invite versions, media, moderation decisions, export jobs, push devices, deletion jobs, audit events), plus:

- `events.storageRegion: string` — enum currently `["pdx1"]`, set at creation, immutable once the first upload lands. Upload grants carry it; the storage adapter resolves credentials/host from it.
- Event, account, media, and capture states unchanged.
- Deletion lifecycle states ship at launch; the **30-day purge job is post-launch**. Guests and organisers can still request deletion in-app (Apple requires in-app account deletion — see App Review section); accounts move to `deletionScheduled` immediately and lose access.

### Events, invitations, media, moderation

As originally specified, with launch modes limited to `manual` and `automatic`; `ai` mode lands post-launch. Photos ≤ 20 MB; videos ≤ 60 s / 250 MB. Private ACLs everywhere; permission-checked short-lived URLs; strip location metadata from derivatives; never retain pre-effect frames (moot at launch — no effects).

## Launch scope (must work on 5 Aug)

### Organiser website

- OTP login, event creation (name, schedule/timezone, cover, accent, moderation mode), six-digit code + QR, invite versions and **rotation** (keep-or-revoke memberships).
- Live home: code/QR, status, pending count, recent submissions, totals.
- Moderation: masonry grid, approve/decline, filters, bulk select. (Keyboard-driven review and submitter grouping if time allows.)
- Slideshow: fullscreen, live-updating, photos + muted autoplay video, pause/skip, chronological or shuffle.
- Settings: essentials only (schedule, moderation mode, co-host invite, rotation).

### Guest mobile web (the guaranteed path)

- QR → HTTPS universal link → join with token or code → Google/OTP sign-in → name confirm.
- Capture/select photo or video (`input capture` / getUserMedia), upload with progress, see own submissions + moderation status, withdraw. Approved event gallery view.

### Expo app (iOS + Android)

- Tabs: Camera, Photos (My media / Event gallery), Settings, conditional Host tab.
- Clean camera: tap photo, hold video, flash, flip, both orientations. Auto-send with 15-s undo; durable local queue with foreground resume (background retry best-effort post-launch).
- Host tab: QR/code, rotation, pending queue, quick approve/decline.
- Push notifications (Expo push): upload failure/recovery, event open/close, pending-queue threshold for hosts.
- **App Review requirements (mandatory for submission):** in-app content reporting, user blocking, in-app account deletion, privacy policy URL, 17+/18+ age rating, Sign in with Apple alongside Google, and a **reviewer demo account** that bypasses live OTP (fixed-code demo login) plus a seeded demo event.

### Admin console (full, as originally planned — at your insistence)

- Distinct `/admin` shell: invite organisers, inspect accounts/events/asset counts/storage, lock/unlock, schedule/restore deletion, rotate codes (random or collision-checked specific), revoke memberships, confirmation + reason + immutable audit on every action. No media access, no impersonation.
- **Cut order if the schedule bites** (agreed risk): specific-value code rotation → job-health dashboards → deletion scheduling UI (script fallback). Organiser invite + lock/unlock + audit are the non-negotiable core.

### Platform

- Turborepo, Bun, strict TS, env validation, shared schemas/permissions/types.
- Convex US East; Better Auth on Convex; Convex subscriptions drive dashboards, galleries, slideshow.
- UploadThing app: paid plan, region **pdx1**, **default ACL Private**, route handlers in `apps/web`. Mobile/web clients request a short-lived one-time upload grant from Convex (`eventId`, `captureId`, `mediaType`, `byteSize`, checksum, `storageRegion`); middleware validates before issuing the upload URL. Idempotent completion callbacks.
- Resend for OTP + invites (DNS verified on day 1). Sentry with scrubbing as originally specified. Rate limits + enumeration protection on join and OTP as originally specified.

## Day-by-day schedule

> Detailed sprint checklists with per-day releasable checkpoints live in [`TODO.md`](TODO.md) — that file is the working tracker; this table is the summary.

| Day                 | Focus                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mon 28 Jul (D0)** | Owner-only account setup — Play Console, Apple app record, UploadThing (pdx1/Private), Convex (US East), Resend DNS, Vercel/Sentry/OAuth, domain. See the notes section at the bottom of `TODO.md`.                            |
| **Tue 29 Jul (D1)** | Repo bootstrap; Expo scaffold + EAS; Better Auth wiring; schema + permission rules; CI; Sentry.                                                                                                                                |
| **Wed 30 Jul (D2)** | Organiser OTP; event CRUD + codes/QR/invite versions; join flow (authenticated, rate-limited, audited); guest auth (app OAuth + web Google/OTP).                                                                               |
| **Thu 31 Jul (D3)** | Upload pipeline end-to-end: grants, route handlers, idempotent callbacks, media states, previews; app camera (photo) + upload queue; web capture page.                                                                         |
| **Fri 1 Aug (D4)**  | Video capture + playback; moderation UI; approved gallery; slideshow v1. **Submit iOS build #1 for review by end of day** (report/block/deletion + demo account included). Android to internal-testing track.                  |
| **Sat 2 Aug (D5)**  | Co-hosts; invite rotation; push notifications; admin console.                                                                                                                                                                  |
| **Sun 3 Aug (D6)**  | Admin console finish; polish; focused tests (unit + Playwright happy path + signed-URL expiry checks); fix iOS review feedback if rejected, resubmit. **Evening: dress-rehearsal party (~5 people, real phones, real Wi-Fi).** |
| **Mon 4 Aug (D7)**  | Fix rehearsal findings; feature freeze by noon; seed the real event; print QR signage with code + web fallback URL; write the party runbook (who moderates, slideshow machine, hotspot fallback).                              |
| **Tue 5 Aug**       | Party. Web path is primary on signage if the app isn't live; App Store/internal-testing links shown only if approved.                                                                                                          |

## Post-launch milestones (former M2–M5, re-cut)

- **P1 — Data lifecycle & AI:** 30-day purge automation, restore flows, AI moderation (`omni-moderation-latest`, resized frames only, conservative auto-approve, never auto-decline), moderation audit records.
- **P2 — Exports & observability:** Trigger.dev ZIP exports (originals + CSV/JSON manifests, expiring private URLs, region-co-located), PostHog dashboards, storage-usage surfacing, cost alerts.
- **P3 — Effects:** Banuba procurement/trial → six effects behind `CameraEffectsAdapter`; fallback = simple non-face filters via vision-camera/Skia, face effects deferred. Physical-device matrix, thermal, orientation.
- **P4 — Distribution & hardening:** Play production (after the 14-day closed-testing gate), accessibility to WCAG 2.2 AA, load test (250 guests / 1,000 assets), full Playwright + Maestro suites, security test matrix from the original plan.
- **P5 — Multi-region storage:** apply for UploadThing dynamic-region private beta; if unavailable, one-app-per-region adapter. Region picker in event setup (auto-suggested from locale, editable, locked at first upload). Curate offered regions when real demand exists.

## Risks

1. **App Review misses Aug 5** — likely enough to plan around. Mitigated: web path is fully sufficient for the party; TestFlight external (faster beta review, public link) as middle option.
2. **Play production impossible by Aug 5** (new-account 14-day rule) — accepted; internal-testing link for Android guests, web path otherwise.
3. **Full admin console competes with party-critical work** — accepted knowingly; cut order documented above.
4. **Solo moderation during the party** — mitigated by co-hosts and `automatic` mode as a pressure valve; AI assist is post-launch.
5. **Convex↔storage cross-country hop (US East ↔ pdx1)** — accepted; affects preview processing latency only.
6. **OTP deliverability on party night** — Resend domain warmed from D1; Google sign-in is the primary web path, OTP the fallback.

## Docs & conventions

`docs/product-spec.md`, `docs/domain-model.md` (entities, permissions, state machines incl. `storageRegion`), `docs/glossary.md`, ADRs (monorepo, Better Auth, private upload pipeline + region adapter, moderation, offline capture, data lifecycle). Commit style: `[new feature] …`, `[fix] …`, `[style] …` with inspected diffs.

## Assumptions (updated)

- Name provisionally PartyBooth; beta is global-English, 18+, invitation-only; no billing, quotas, public media URLs, facial recognition, or admin impersonation.
- "Original" = final submitted capture including applied effects (no pre-effect frames retained).
- Deferred: marketing, paid plans, child accounts, custom domains. The guest web experience is **no longer deferred** — it is launch scope.
