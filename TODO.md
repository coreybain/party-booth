# PartyBooth — Sprint TODO (28 Jul → 5 Aug 2026)

Each day is a sprint that ends in a **releasable checkpoint**: something deployed that you can open on a real phone and test that evening. Web deploys to Vercel on every merge (preview → promote to prod when the checkpoint passes). Mobile ships as an EAS dev/internal build whenever the native surface changes.

Legend: `[ ]` todo · `[x]` done · **RC** = releasable checkpoint you verify before stopping for the day.

---

## Sprint 1 — Tue 29 Jul: skeleton online

- [x] Turborepo + pnpm workspaces, strict TS, shared eslint/prettier/vitest config, env validation (`t3-env` style)
- [x] `packages/backend`: Convex schema v1 — users, organiserInvitations, events (incl. `storageRegion`), memberships, inviteVersions, media, moderationDecisions, pushDevices, deletionJobs, auditEvents (+ `otpChallenges` throttle table)
- [x] `packages/contracts`: shared zod schemas, permission rules, role types
- [x] Better Auth on Convex: email OTP provider wired (Resend), Google + Apple providers configured *(code complete; needs real keys)*
- [x] `apps/web` scaffold (Next.js App Router) deployed to Vercel; `apps/mobile` scaffold (Expo Router) building via EAS *(builds green offline; Vercel link + `eas init` are owner steps)*
- [x] Sentry wired into web + Convex; scrubbing rules for tokens/emails/URLs
- [x] CI: typecheck + unit tests on push *(authored + reproduced locally; needs GitHub remote to run)*

**RC1:** visit the Vercel URL → request an OTP → receive a real email → sign in as organiser → see an empty authenticated shell. Expo dev build installs and opens on your phone.
> ⏳ **RC1 blocked on owner setup only** (accounts/keys/deploys — see notes section). Code side verified: 560 tests, offline typecheck/build green, Fable audit passed. **Add your email to `ADMIN_EMAIL_ALLOWLIST` before testing RC1** — organiser access is invitation-gated.

---

## Sprint 2 — Wed 30 Jul: events & joining

- [x] Event CRUD: create/edit (name, schedule + timezone, cover, accent, moderation mode), states `draft/scheduled/live/paused/archived` *(cover upload is Sprint 3 — the field is reserved)*
- [x] Six-digit code generation (unique among joinable), high-entropy QR token, inviteVersion model *(archiving frees a code implicitly; re-opening re-checks it)*
- [x] Join flow (Convex): authenticated, rate-limited, enumeration-protected, audited; membership creation
- [x] Web join page: `/join/<token>` universal-link target + code entry fallback with store links *(QR encoder is ours, in `@partybooth/contracts/qr` — no third party sees a token)*
- [x] Guest auth: app Apple/Google onboarding (name + photo confirm); web Google + email OTP *(photo is remembered on-device until the Sprint 3 upload pipeline)*
- [x] Verified-email matching → organiser/co-host powers on mobile
- [x] Mobile: event join by code, active-event selection
- [x] Unit tests: permission rules, event state transitions, code/token generation, join rate limits

**RC2:** on your phone (web + app): create an event on desktop, scan its QR with your phone, sign in as a guest, land in the event. Second phone joins by typing the code.
> ⏳ **RC2 blocked on the same owner setup as RC1** (Convex deployment, Vercel link, OAuth keys — see the notes section). Code side verified: 907 tests, offline typecheck/lint/format green, `next build` and `expo export` both pass with an **empty** environment. Audit findings addressed: join-throttle bypass on success, invite-version immutability on re-open and rotation, join/preview auditing, active-event switch on the app, onboarding gate on both join routes, and the two `/.well-known/` association documents.

---

## Sprint 3 — Thu 31 Jul: the upload spine (highest-risk sprint)

- [x] Upload grants: Convex mutation issues short-lived one-time grant (`eventId`, `captureId`, `mediaType`, `byteSize`, checksum, `storageRegion`)
- [x] UploadThing route handlers in `apps/web`; middleware validates grant; private ACL enforced
- [x] Idempotent completion callback → media record (`processing → pending/approved` per mode), reconciles out-of-order callbacks
- [ ] Preview/poster derivatives; strip location metadata from served derivatives *(**open — moved to Sprint 4.** The client half is done and is the one that matters for privacy: every capture on both clients is re-encoded to a fresh JPEG before it is sent, so no EXIF/GPS block ever reaches storage, and `sourceMetadataStripped` records the claim. What does **not** exist is the **server-side** derivative step — nothing writes `previewKey`/`posterKey`, so `projectMedia` serves the original to its submitter and to hosts and serves nothing to a fellow guest when a row did not claim a strip. `mayServeOriginal` in `packages/backend/convex/lib/media.ts` is the seam it lands behind; when it does, that branch becomes "serve the derivative" rather than "serve nothing". Video posters are the same step and are Sprint 4 anyway.)*
- [x] Permission-checked short-lived URL issuance for every read path
- [x] Mobile camera: photo capture (tap), auto-send with 15-s undo, durable local queue with foreground resume
- [x] Library import (photo) with per-event permission flag
- [x] Guest web capture page: `input capture` photo → grant → upload with progress
- [x] "My media" list (app + web): status, retry, cancel, withdraw
- [x] Unit tests: grant expiry/single-use, callback idempotency, media state machine

**RC3:** photo taken on your phone (app AND web path) lands as `pending` in the organiser's media list within seconds; withdrawn media disappears; a second signed-in guest cannot fetch it by URL.
> ⏳ **RC3 not yet verified.** The previous note here said "blocked on owner setup only", and that was wrong: the app path was also blocked on code. The capture machinery (`use-capture`, `camera-controls`, `undo-pill`) was built and unit-tested but **imported by nothing** — `(tabs)/camera.tsx` still rendered the Sprint 2 placeholder and no `CameraView` existed anywhere in the app, and `(tabs)/photos.tsx` still rendered two empty states while `media.myMedia` and `media.withdraw` were live and already wired on web. Every test in the repo was green throughout, because nothing in `apps/mobile` rendered a screen. Both surfaces are now mounted, and the package has a second Vitest project (`mobile-screens`, jsdom with `react-native` aliased to `react-native-web`) whose whole job is to fail when a screen stops mounting what it claims to.
>
> What remains is genuinely owner setup: `UPLOADTHING_TOKEN` (Vercel *and* Convex), `UPLOAD_CALLBACK_SECRET` (same value in both), `SITE_URL`, and three UploadThing dashboard settings — paid plan, region `pdx1` + default ACL **Private**, and **per-request ACL override enabled** (the route handler declares `acl: "private"` in code). Code side verified: **1319 tests**, offline typecheck/lint/format green, `next build` and `expo export --platform all` both pass with an **empty** environment. An earlier integration pass also found and fixed one RC3-blocking defect: `apps/mobile` was sending only the grant secret where the route handler parses the full upload ticket, so every app-path upload would have been refused before a byte moved — the ticket now has one definition, in `@partybooth/contracts/upload`, that both sides parse. The checkpoint itself stays unticked until it is *verified on a phone*, per CONTRIBUTING ("a sprint is done when its RC is verified, not when the code is written").

---

## Sprint 4 — Fri 1 Aug: moderate, watch, submit ⚠️ iOS submission deadline

- [x] **Carried from Sprint 3:** the derivative step — writes `previewKey`/`posterKey`, which turns `mayServeOriginal`'s "serve nothing" branch into "serve the derivative" *(**client-produced, not server-side** — see [ADR 0008](docs/adr/0008-client-produced-derivatives.md). Convex's isolate cannot host an image pipeline and a server step would have to store the GPS-bearing original first, so the derivatives are made by the same re-encode that already strips the EXIF block and uploaded through the existing grant spine: same `captureId`, distinct `fileRole`, own grant, own 2 MiB cap, and the re-encode claim is **required** rather than recorded. A derivative attaches a key and nothing else — it never settles the row or moves a counter, so one capture stays one submission, and a capture with no derivative is never stranded. The "serve nothing" branch survives for exactly that case.)*
- [x] Video: hold-to-record (≤60 s), upload, poster generation, muted autoplay playback *(**both clients done** — hold the shutter, 250 ms threshold, visible 60 s ring, torch, client-produced poster, `expo-video` playback muted-by-default from a signed URL. The gesture is a pure state machine (`src/lib/shutter.ts`) plus `useShutter`, which exists because `react-native-web`'s `Pressable` does not fire `onPressIn`/`onPressOut` under jsdom — behind the hook the presses are function calls and the orchestration is testable. A video's `preview` role, i.e. a downscaled muted **clip**, is deliberately **not** produced: it needs a transcoder Expo does not ship, `projectMedia` falls back to the poster, and the cost is bandwidth on a grid rather than visibility. Post-launch, P2. Web capture is a separate `input[capture]` for video — one input accepting both is the combination phones disagree about — with the poster drawn through the same canvas the photo pipeline uses; playback is poster + click-to-play, `muted`/`playsInline`, never autoplay in a grid. Integration reconciled the two clients: `posterFrameTime` and the poster's size and quality now come from `@partybooth/contracts/capture` rather than from a private constant in each app, which were the same numbers written twice and free to drift.)*
- [x] Moderation UI: masonry grid, approve/decline, status/type/submitter filters, bulk select *(`/media`; per-card approve/decline/revoke, shift-range multi-select, sticky bulk bar, keyboard review, reported-items panel above the grid. Nothing is optimistic — every button offered is one `moderationTransition` says would change something, which is the same pure function the mutation runs, and partial refusals are reported verbatim. DOM bounded by an `IntersectionObserver` at 60 cards.)*
- [x] Approved event gallery (app + web), live via Convex subscriptions
- [x] Slideshow: fullscreen, live-updating, photos + muted video, pause/skip, shuffle/chronological, configurable photo timing *(`/slideshow`; two-layer crossfade, per-slide timing, videos play full duration and advance on `ended`, wake lock re-acquired on `visibilitychange`, and the feed re-read every five minutes so signed URLs stay valid across a five-hour show. Media that will not load is skipped permanently after a load budget.)*
- [x] Organiser home: code/QR, status, pending count, recent submissions, totals *(two queries kept deliberately separate: `stats.overview` is numbers an admin may read, `stats.recentSubmissions` mints signed URLs and is host-only and not rendered for a non-host at all.)*
- [x] App Review requirements: report-content flow, block-user flow, in-app account deletion (`deletionScheduled`, access revoked), privacy policy page, 18+ rating, reviewer demo login (fixed OTP) + seeded demo event *(**code complete on both sides; the deployment steps are owner actions, listed below.** `/privacy` exists in `apps/web`, is public, static and outside every shell, and prerenders in an empty-environment `next build`. App side — long-press or the "…" on any gallery tile that is not yours → report with a reason → confirmation, with a block offer straight after; blocking is also its own control and is listed and undoable in Settings → Blocked people; Settings → Delete account is two taps, revokes access immediately, signs out, and says in plain words that the purge is 30 days out and that photographs are kept but anonymised. The privacy link opens `<siteUrl>/privacy` in an in-app browser. Report and block copy is now one definition in `@partybooth/contracts/copy`, in two deliberate registers — the guest picking a reason and the host reading the queue want different sentences, but never different meanings.)*
- [ ] **Submit iOS build #1 to App Store review (end of day, non-negotiable)** — ⚠️ **OWNER ACTION; deliberately not ticked.** Nothing in this repo can tick it: it is an App Store Connect record, an age-rating questionnaire, screenshots and an `eas submit`, none of which a build can perform or verify. *(Everything code-side is ready: `app.config.ts` final pass, EAS submit profiles with env-read `ascAppId`/`appleTeamId`, non-placeholder icon set (`pnpm icons`). The remaining work is entirely in App Store Connect and is written out step by step, with the review-notes template and every questionnaire answer, in [`docs/store/ios-submission.md`](docs/store/ios-submission.md).)*
- [ ] Upload Android build to Play **internal testing**; grab the opt-in link — ⚠️ **OWNER ACTION; deliberately not ticked**, for the same reason as the line above. *(Steps, forms and the assetlinks gotcha — the SHA-256 must be the **Play-signed** key, not the upload key — in [`docs/store/android-internal.md`](docs/store/android-internal.md).)*

> **Integration status (Sprint 4).** The three streams are merged on `feat/sprint4` and the gate is green offline with an **empty environment**: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` — **1689 tests** (contracts 450, backend 498, web 316, mobile 390, env 35) — `pnpm format:check`, plus `next build` and `expo export --platform all`.
>
> Every contract-change request the three builders raised was applied rather than deferred, because each was a *shared* number or string that had been written twice:
>
> - **`sourceMetadataStripped` split in two** (`MetadataClaim`). It had to mean "was re-encoded" for the derivative grant and "carries no location" for the read path, and video made those different facts — the app path was asserting a re-encode it had not performed in order to get visibility it had honestly earned. The read path now asks about location, the derivative grant about encoding, and an absent second flag inherits the first, so **no stored row changed meaning or visibility**. Four backend tests pin exactly that.
> - **The uploaded-derivative size moved into `DERIVATIVE_PROFILES`** as a `shared` tier, identical on both clients (1280 px @ q0.8 — the numbers both had independently chosen, in two private constants). The web path had been uploading its 480 px *local thumbnail* as the shared `preview`, so third parties on the web path were served a quarter of what the app served; it now encodes its own. The profile's old `preview*` fields are renamed `thumbnail*`, which removes the collision with `MediaFileRole`'s `preview` that caused the confusion.
> - **`derivativeFileName` covers all four artefacts and any container**, so `derivativeFileName(id, "preview")` names the file uploaded with `fileRole: "preview"` on both clients. `videoContainerFor` and `posterFrameTime` joined it: the two apps had been sampling posters at 150 ms and 1 s, so the same clip got a different thumbnail depending on which app recorded it.
> - **`GRANT_POLICY.maxPerWindow` 60 → 180.** Derivatives made a capture cost 2–3 grants, which had quietly turned "60 captures per five minutes" into about 20. Both client agents flagged the arithmetic independently; the ceiling now means what its comment says again.
> - **Duplicated copy and formatters hoisted** into `@partybooth/contracts/copy`: report reasons in two deliberate registers (guest and host), `formatBytes` (the app's copy had no gigabyte tier, so one party's storage read "4096 MB" on a phone and "4.0 GB" on a laptop), and `formatDuration`, which existed byte-for-byte twice. Block copy was *not* hoisted — blocking is a mobile-only surface, so there is only one of it.
>
> **Reconciliation worth flagging:** the demo-login variables are `DEMO_LOGIN_EMAIL` / `DEMO_LOGIN_OTP`, not the `DEMO_ACCOUNT_EMAIL` / `DEMO_FIXED_OTP` some planning notes use. The implemented names have been validated in `packages/env` and documented in `.env.example` since Sprint 1; renaming them on submission day would be churn against a working, tested path. `.env.example` now says so explicitly, and also documents `APPLE_ID`, `ASC_APP_ID` and `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, which `eas.json` referenced but nothing described.

**RC4:** run a fake mini-party solo: phone uploads photo + video → approve on laptop → both appear on the TV slideshow live. iOS build shows "Waiting for Review".
> **Mobile status (Sprint 4).** `apps/mobile` is code-complete for its Sprint 4 lines: video capture and playback, the client half of the derivative step (photo `preview` and video `poster`, each its own grant under the same `captureId`), the three App Review flows, the store-readiness pass, and the two submission checklists in `docs/store/`. **389 mobile tests** (was 289); `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check` and `expo export --platform all` all pass with an **empty** environment.
>
> **Three things the app cannot do for itself**, in the order they block submission: (1) the deployed site must actually serve `/privacy` — the route exists in `apps/web`, Settings links to it, and App Review rejects a dead privacy URL; (2) the demo login variables and `pnpm seed:demo <keys…>` must be set on the deployment Apple reviews (backend note below); (3) the App Store Connect record, questionnaires and screenshots are owner-only — `docs/store/ios-submission.md` has every answer pre-filled.
>
> **Backend status (Sprint 4).** Everything the Sprint 4 lines above need from Convex is in and tested offline: derivative ingestion (`fileRole` on grant/ticket/completion, ADR 0008); moderation `approve`/`decline`/`revoke` with bulk and partial success (ADR 0005); the organiser-home stats queries; a cursored live slideshow feed; report-content, block-user and `users.requestAccountDeletion`; and the env-gated fixed-OTP demo login with `pnpm seed:demo`. **Two owner-action items before submission:** set `DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_OTP` on the deployment Apple will review and run `pnpm seed:demo <key…>` with two or three uploaded asset keys (without keys the demo party has rows but no thumbnails, because a Convex mutation cannot put bytes in storage) — then **unset both variables once the build is approved**.

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
- [ ] Fill in `APPLE_TEAM_ID`, `APPLE_APP_BUNDLE_IDENTIFIER` and `ANDROID_CERT_FINGERPRINTS` (Play Console → Setup → App signing → SHA-256). Without them, `apps/web` serves 404 at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, and a scanned QR opens the browser instead of the app. After deploying, run `pnpm verify:app-links https://<your-domain>` — do this **before** printing signage; both platforms cache what they fetch at install time.
- [ ] Drop all resulting API keys/secrets into the env files (Claude will scaffold `.env.example` in Sprint 1 so you know exactly what goes where)

Done when: every provider dashboard is reachable and DNS records are submitted.
