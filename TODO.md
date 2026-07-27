# PartyBooth — Sprint TODO (28 Jul → 5 Aug 2026)

Each day is a sprint that ends in a **releasable checkpoint**: something deployed that you can open on a real phone and test that evening. Web deploys to Vercel on every merge (preview → promote to prod when the checkpoint passes). Mobile ships as an EAS dev/internal build whenever the native surface changes.

Legend: `[ ]` todo · `[x]` done · **RC** = releasable checkpoint you verify before stopping for the day.

---

## Sprint 1 — Tue 29 Jul: skeleton online

- [ ] Turborepo + pnpm workspaces, strict TS, shared eslint/prettier/vitest config, env validation (`t3-env` style)
- [ ] `packages/backend`: Convex schema v1 — users, organiserInvitations, events (incl. `storageRegion`), memberships, inviteVersions, media, moderationDecisions, pushDevices, deletionJobs, auditEvents
- [ ] `packages/contracts`: shared zod schemas, permission rules, role types
- [ ] Better Auth on Convex: email OTP provider wired (Resend), Google + Apple providers configured
- [ ] `apps/web` scaffold (Next.js App Router) deployed to Vercel; `apps/mobile` scaffold (Expo Router) building via EAS
- [ ] Sentry wired into web + Convex; scrubbing rules for tokens/emails/URLs
- [ ] CI: typecheck + unit tests on push

**RC1:** visit the Vercel URL → request an OTP → receive a real email → sign in as organiser → see an empty authenticated shell. Expo dev build installs and opens on your phone.

---

## Sprint 2 — Wed 30 Jul: events & joining

- [ ] Event CRUD: create/edit (name, schedule + timezone, cover, accent, moderation mode), states `draft/scheduled/live/paused/archived`
- [ ] Six-digit code generation (unique among joinable), high-entropy QR token, inviteVersion model
- [ ] Join flow (Convex): authenticated, rate-limited, enumeration-protected, audited; membership creation
- [ ] Web join page: `/join/<token>` universal-link target + code entry fallback with store links
- [ ] Guest auth: app Apple/Google onboarding (name + photo confirm); web Google + email OTP
- [ ] Verified-email matching → organiser/co-host powers on mobile
- [ ] Mobile: event join by code, active-event selection
- [ ] Unit tests: permission rules, event state transitions, code/token generation, join rate limits

**RC2:** on your phone (web + app): create an event on desktop, scan its QR with your phone, sign in as a guest, land in the event. Second phone joins by typing the code.

---

## Sprint 3 — Thu 31 Jul: the upload spine (highest-risk sprint)

- [ ] Upload grants: Convex mutation issues short-lived one-time grant (`eventId`, `captureId`, `mediaType`, `byteSize`, checksum, `storageRegion`)
- [ ] UploadThing route handlers in `apps/web`; middleware validates grant; private ACL enforced
- [ ] Idempotent completion callback → media record (`processing → pending/approved` per mode), reconciles out-of-order callbacks
- [ ] Preview/poster derivatives; strip location metadata from served derivatives
- [ ] Permission-checked short-lived URL issuance for every read path
- [ ] Mobile camera: photo capture (tap), auto-send with 15-s undo, durable local queue with foreground resume
- [ ] Library import (photo) with per-event permission flag
- [ ] Guest web capture page: `input capture` photo → grant → upload with progress
- [ ] "My media" list (app + web): status, retry, cancel, withdraw
- [ ] Unit tests: grant expiry/single-use, callback idempotency, media state machine

**RC3:** photo taken on your phone (app AND web path) lands as `pending` in the organiser's media list within seconds; withdrawn media disappears; a second signed-in guest cannot fetch it by URL.

---

## Sprint 4 — Fri 1 Aug: moderate, watch, submit ⚠️ iOS submission deadline

- [ ] Video: hold-to-record (≤60 s), upload, poster generation, muted autoplay playback
- [ ] Moderation UI: masonry grid, approve/decline, status/type/submitter filters, bulk select
- [ ] Approved event gallery (app + web), live via Convex subscriptions
- [ ] Slideshow: fullscreen, live-updating, photos + muted video, pause/skip, shuffle/chronological, configurable photo timing
- [ ] Organiser home: code/QR, status, pending count, recent submissions, totals
- [ ] App Review requirements: report-content flow, block-user flow, in-app account deletion (`deletionScheduled`, access revoked), privacy policy page, 18+ rating, reviewer demo login (fixed OTP) + seeded demo event
- [ ] **Submit iOS build #1 to App Store review (end of day, non-negotiable)**
- [ ] Upload Android build to Play **internal testing**; grab the opt-in link

**RC4:** run a fake mini-party solo: phone uploads photo + video → approve on laptop → both appear on the TV slideshow live. iOS build shows "Waiting for Review".

---

## Sprint 5 — Sat 2 Aug: hosts, rotation, push, admin

- [ ] Co-host invites (email), co-host permission enforcement everywhere (no delete/transfer/ownership)
- [ ] Invite rotation: new code + QR token, keep-or-revoke choice, old version rejected at join
- [ ] Host tab (app): QR/code, rotation, pending queue, quick approve/decline
- [ ] Expo push: tokens, upload failure/recovery, event open/close, host pending-threshold pings
- [ ] Admin console `/admin`: distinct shell, OTP + allowlist; invite organiser; accounts/events/asset/storage overview; lock/unlock; schedule/restore deletion; rotate codes (random or collision-checked specific); revoke memberships; confirmation + reason + immutable audit on every action
- [ ] Account lock enforcement: suspends owner/co-host access, joins, uploads, slideshows across owned events
- [ ] Cut order if behind (pre-agreed): specific-value rotation → job-health views → deletion-scheduling UI (script fallback)

**RC5:** second account as co-host moderates from their phone; rotate the code mid-"event" and confirm the old QR is dead; lock the organiser from `/admin` and watch everything freeze.

---

## Sprint 6 — Sun 3 Aug: harden + dress rehearsal 🎪

- [ ] Playwright happy path: OTP login → create event → guest joins → upload → moderate → slideshow
- [ ] Security spot-checks: expired grant reuse, expired signed URL, cross-event media fetch, revoked inviteVersion join, OTP brute-force lockout
- [ ] Manual pass on 2 physical phones (1 iOS, 1 Android) — both app and web paths
- [ ] Polish: empty states, error toasts, upload-progress edge cases, slideshow transitions
- [ ] Handle iOS review feedback if rejected; resubmit same day
- [ ] **Evening: dress-rehearsal party — ~5 real people, real phones, home Wi-Fi + one phone on cellular; run the full night: join → capture → moderate → slideshow → rotation**
- [ ] Log every rehearsal finding as a ticket before bed

**RC6:** rehearsal completes end-to-end with no intervention that a real host couldn't do. Findings list exists and is triaged (fix / accept / party-runbook note).

---

## Sprint 7 — Mon 4 Aug: freeze & stage

- [ ] Fix rehearsal findings (morning only)
- [ ] **Feature freeze at noon** — after this, config and copy only
- [ ] Seed the real event in prod; verify code + QR + web fallback on cellular from a fresh phone
- [ ] Print QR signage: QR + six-digit code + web URL (web URL is primary if the app isn't approved)
- [ ] Party runbook: who moderates (you + co-host), slideshow machine + spare cable, hotspot fallback, `automatic` mode as pressure valve, admin lock procedure, provider status pages
- [ ] Charge everything; download offline copies of the runbook

**RC7:** a fresh phone that has never seen the project can go from QR on paper → contributing guest in under 90 seconds, on cellular.

---

## Party — Tue 5 Aug 🎉

- Slideshow up before first guest; moderation phone in pocket; switch to `automatic` if the pending queue outruns you.
- Capture issues in a note as they happen — they seed the post-launch backlog.

---

## Post-launch sprints (weekly cadence, releasable each Friday)

- **P1 (w/c 10 Aug) — Data lifecycle & AI:** 30-day purge automation + restore; AI moderation (`omni-moderation-latest`, resized frames only, conservative auto-approve, never auto-decline); moderation audit trail. _Release: `ai` mode selectable per event._
- **P2 (w/c 17 Aug) — Exports & observability:** Trigger.dev ZIP exports (originals + CSV/JSON manifests, expiring private URLs, region-co-located); PostHog; storage usage surfacing; cost alerts. _Release: organiser downloads a full-event archive._
- **P3 (w/c 24 Aug) — Effects:** Banuba procurement/trial → six effects behind `CameraEffectsAdapter`; fallback simple non-face filters (vision-camera/Skia). Physical-device matrix. _Release: effects carousel live in TestFlight._
- **P4 (w/c 31 Aug) — Distribution & hardening:** Play production (closed-testing gate elapses ~11 Aug; run the 12-tester test from launch guests), WCAG 2.2 AA pass, 250-guest load test, full Playwright + Maestro suites, security matrix. _Release: public store listings._
- **P5 (Sep) — Multi-region storage:** UploadThing dynamic-region beta application (or one-app-per-region adapter), event-setup region picker (auto-suggested, editable, locked at first upload). _Release: second region live for a real overseas event._

---

## 📋 Notes for Corey — manual account setup (outside the build)

Not part of any sprint; these are third-party clocks and dashboard logins only you can do. **Do these tonight (Mon 28 Jul)** — none can be compressed later, and Sprint 1 assumes the credentials exist.

- [ ] Create **Play Console** account — starts the 14-day production-access clock (internal testing works immediately)
- [ ] Verify **Apple Developer** membership is active; create App ID / bundle `com.partybooth.app`
- [ ] Create **UploadThing** app: paid plan, region **pdx1**, default ACL **Private**
- [ ] Create **Convex** project in **US East (N. Virginia)** (dev + prod deployments)
- [ ] Add **Resend** domain + DNS records (SPF/DKIM need propagation time)
- [ ] Create **Vercel** project, **Sentry** project, **Google OAuth** client, **Apple Sign-In** service config
- [ ] Buy/confirm the **domain** used for QR universal links
- [ ] Drop all resulting API keys/secrets into the env files (Claude will scaffold `.env.example` in Sprint 1 so you know exactly what goes where)

Done when: every provider dashboard is reachable and DNS records are submitted.
