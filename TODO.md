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

> **Sprint 4 audit fixes (applied on `feat/sprint4`).** Six findings shared one shape — a control
> reading a value the controlled party supplied — and they are recorded together in
> [ADR 0009](docs/adr/0009-verified-uploads-and-real-deletion.md): the 60-second video cap is now
> **measured** from the stored file's own header rather than re-read off the client's ticket; a
> derivative whose checksum equals its original's is refused (that was the way around
> `mayServeOriginal`) and its location claim is read at read time; a retry may not change what file
> a capture is; the video `preview` role — never produced by either client, 25 MiB, original's
> containers — is withdrawn; the slideshow cursors on **approval** time and the client reconciles
> against the authoritative approved set, so an item a host revokes leaves the television at once;
> and the reviewer credential is confined to the demo party and expires on a date
> (`DEMO_LOGIN_EXPIRES_AT` — **a third variable, required**).
>
> Two store-policy gaps closed with them, and both were claimed as done and were not: **account
> deletion now actually deletes** — `convex/deletion.ts` on a daily cron erases media, objects,
> memberships, blocks, devices and the Better Auth credential thirty days out, and the in-app,
> privacy and store copy says what the code does — and **terms of use now exist** at `/terms`, are
> accepted at onboarding on both clients (versioned, recorded), and are required before an upload
> grant is issued. `/account/deletion` is the web deletion route Play's policy requires and
> `android-internal.md` declares. `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` are gone from the Android
> manifest — the system photo picker needs neither — and the iOS age-rating section is rewritten
> against the current 4+/9+/13+/16+/18+ questionnaire.
>
> **New owner-action item:** set `DEMO_LOGIN_EXPIRES_AT` alongside the other two demo variables, or
> the reviewer login does not exist. See `.env.example`.

**RC4:** run a fake mini-party solo: phone uploads photo + video → approve on laptop → both appear on the TV slideshow live. iOS build shows "Waiting for Review".
> **Mobile status (Sprint 4).** `apps/mobile` is code-complete for its Sprint 4 lines: video capture and playback, the client half of the derivative step (photo `preview` and video `poster`, each its own grant under the same `captureId`), the three App Review flows, the store-readiness pass, and the two submission checklists in `docs/store/`. **389 mobile tests** (was 289); `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check` and `expo export --platform all` all pass with an **empty** environment.
>
> **Three things the app cannot do for itself**, in the order they block submission: (1) the deployed site must actually serve `/privacy` — the route exists in `apps/web`, Settings links to it, and App Review rejects a dead privacy URL; (2) the demo login variables and `pnpm seed:demo <keys…>` must be set on the deployment Apple reviews (backend note below); (3) the App Store Connect record, questionnaires and screenshots are owner-only — `docs/store/ios-submission.md` has every answer pre-filled.
>
> **Backend status (Sprint 4).** Everything the Sprint 4 lines above need from Convex is in and tested offline: derivative ingestion (`fileRole` on grant/ticket/completion, ADR 0008); moderation `approve`/`decline`/`revoke` with bulk and partial success (ADR 0005); the organiser-home stats queries; a cursored live slideshow feed; report-content, block-user and `users.requestAccountDeletion`; and the env-gated fixed-OTP demo login with `pnpm seed:demo`. **Two owner-action items before submission:** set `DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_OTP` on the deployment Apple will review and run `pnpm seed:demo <key…>` with two or three uploaded asset keys (without keys the demo party has rows but no thumbnails, because a Convex mutation cannot put bytes in storage) — then **unset both variables once the build is approved**.

---

## Sprint 5 — Sat 2 Aug: hosts, rotation, push, admin

- [x] Co-host invites (email), co-host permission enforcement everywhere (no delete/transfer/ownership)
- [x] Invite rotation: new code + QR token, keep-or-revoke choice, old version rejected at join
- [x] Host tab (app): QR/code, rotation, pending queue, quick approve/decline
- [x] Expo push: tokens, upload failure/recovery, event open/close, host pending-threshold pings
- [x] Admin console `/admin`: distinct shell, OTP + allowlist; invite organiser; accounts/events/asset/storage overview; lock/unlock; schedule/restore deletion; rotate codes (random or collision-checked specific); revoke memberships; confirmation + reason + immutable audit on every action
- [x] Account lock enforcement: suspends owner/co-host access, joins, uploads, slideshows across owned events
- [x] Cut order if behind (pre-agreed): specific-value rotation → job-health views → deletion-scheduling UI (script fallback) — **nothing was cut.** All three shipped: specific-value rotation is collision-checked in Convex and entropy-checked in the console, job health is a live panel on `/admin`, and deletion scheduling has console UI for both accounts and events (no script fallback needed)

**Genuinely not built, and deliberate:**

- **Swipe-to-moderate on the Host tab** — approve/decline are buttons. A swipe needs
  `react-native-gesture-handler` wiring that cannot be tested under jsdom, and two 52pt targets are
  faster in a dim room. Revisit if the Sprint 6 rehearsal disagrees.
- **`pendingExports` in job health reads a constant zero** — ZIP exports are P2 and there is no job
  table to count yet. The field exists so the panel does not change shape when they land.
- **No DOM-level component tests on web** (`vitest.config.ts` is `environment: "node"`). Component
  logic is extracted and tested beside each component; browser-level testing is Sprint 6's Playwright
  line, per PLAN.md.

**RC5 is not ticked**: it is a manual two-account, two-phone verification, and Sprint 5's own rule is
that a sprint is done when its RC is _verified_, not when the code is written. The three demos are
covered by suites (`convex/lock.test.ts`, `convex/rotation.test.ts`, `src/test/host-tab.test.tsx`),
which is not the same thing as having done it.

**RC5's third scenario would have failed on the phones**, and that is now fixed rather than
discovered on the night. "Lock the organiser and watch everything freeze" was true of every *new*
read and write and false of the uploads already authorised: `lockAccount` expired only the locked
person's own grants, so for the two minutes of `GRANT_POLICY.ttlMs` a guest's unspent grant still
landed a file in the suspended party, moved its counters and pinged its hosts. The sweep now covers
every grant the account holds anywhere **and** every grant anybody holds for a party it owns, and
`media.completeUpload` re-asks the freeze question at the one place bytes are accepted — so the
guarantee no longer rests on an enumeration performed once. `convex/lock.test.ts` exercises it with
genuine guest and co-host grants; the version that shipped used a grant attributed to the owner,
which is why the suite was green over the gap.

**Still owner-action, and still not ticked:** the two-account, two-phone exercise itself. The code
gap is closed and the demos are covered offline, but nobody has yet held two phones and watched it.
**RC5:** second account as co-host moderates from their phone; rotate the code mid-"event" and confirm the old QR is dead; lock the organiser from `/admin` and watch everything freeze.
> **Backend status (Sprint 5).** Everything the lines above need from Convex is in and tested
> offline — **627 backend tests**, 495 contracts tests, `pnpm typecheck` / `pnpm lint` (0 errors) /
> `pnpm format:check` green with an **empty environment**. New surface: `convex/cohosts.ts` (invite
> by email through the existing Resend sender, revoke the invitation, remove a co-host),
> `convex/push.ts` + `convex/lib/push/` (device registration, per-category preferences, dispatch via
> the scheduler, Expo HTTP behind an adapter with a fake), `convex/admin.ts` (accounts, events, job
> health, audit log, organiser invite, lock/unlock, schedule/restore deletion for accounts *and*
> events, code rotation random-or-specific, membership revocation) and `convex/lib/lock.ts`.
>
> **Nothing on the cut list was cut**: specific-value rotation, job-health figures and the deletion
> scheduling all shipped. `pendingExports` in job health deliberately reads a constant zero — ZIP
> exports are P2 and there is no job table to count.
>
> **Three findings the sprint turned up, all fixed here rather than deferred**, recorded in
> [ADR 0010](docs/adr/0010-lock-sweep-and-push-adapter.md):
>
> - **Locking an account froze nothing but the account.** Every check in the product asked about the
>   *caller*; none asked about the *party*. A locked host's co-host kept moderating, their guests
>   kept uploading and new guests kept joining off a printed QR. The freeze is now derived from the
>   event's owner and asserted in `requireEventActor` — the one function every event-scoped read and
>   write passes through — plus `join.ts`, which is the only path that reaches an event without a
>   membership. This is the RC5 demo, and it is now a suite (`convex/lock.test.ts`).
> - **`envHas` returned `true` for unset optional variables**, because an optional zod schema parses
>   an absent value successfully. Every `serverFeatures` flag reading an optional variable was
>   permanently on — `sentry` with no DSN, `expoPush` with no Expo project, which in tests meant the
>   push suite reached the real `exp.host`. One line in `packages/env`; it now asks about the value.
> - **A revoked membership survived a rotation sweep as a permanent ban.** `keepExistingMemberships:
>   false` revokes every guest, and the join path refused any revoked membership even on a valid new
>   code — so "rotate and revoke" banned the whole guest list for ever. `memberships.
>   revokedByRotation` now distinguishes a *sweep* from a host's deliberate *removal*: a removal
>   still survives a fresh scan, a sweep does not.
>
> **Contract changes applied** (all in `@partybooth/contracts`, all with the permission matrix test
> updated): co-hosts gained `event.update`, `event.changeModerationMode` and `event.changeState` —
> PLAN.md's mitigation for solo moderation is "co-hosts and `automatic` mode as a pressure valve",
> and a co-host who cannot reach the switch is not one — and **lost** the ability to revoke another
> co-host or to archive the event. `event.archive` existed in the matrix since Sprint 1 and was read
> by nothing; `events.setState` now demands it for the `archived` destination.
>
> **Owner-action items:** none new for the party path. Push delivery needs `EAS_PROJECT_ID` set on
> the Convex deployment (and optionally `EXPO_ACCESS_TOKEN` for enhanced push security) — both are
> already in `.env.example`; with neither set, notifications are queued, marked `dropped` and
> nothing throws. `ADMIN_EMAIL_ALLOWLIST` must contain your address before `/admin` will answer.

> **Mobile status (Sprint 5).** `apps/mobile` is code-complete for its two lines — the Host tab and
> Expo push — plus the upload-queue reporting the failure/recovery ping needs. **489 mobile tests**
> (was 390); `pnpm typecheck`, `pnpm lint`, `pnpm test` and `expo export --platform all` all pass
> with an **empty** environment.
>
> The **Host tab** replaces the Sprint 2 scaffold: the six-digit code spaced for reading aloud and a
> QR of the join URL, rotation behind a keep-or-revoke modal, the party controls (open early, pause,
> resume, add an hour, end — the last owner-only), the live pending queue with one-tap approve and
> decline plus "approve everything", and reported items surfaced above the queue with their reason.
> Nothing is optimistic: every control shown is one `hostAbilities` says the contract would allow
> for this role in this event state, and a partial refusal from `moderation.moderate` is reported
> verbatim. A **locked** host now gets a screen that says their account is locked, rather than the
> guest's "ask the host to add you as a co-host" — that is the RC5 demo seen from the phone.
>
> The QR is drawn with `View`s rather than SVG. `react-native-svg` is a native module, so adding it
> during launch week means a new EAS build for every client that wants to see a code;
> `src/lib/qr-view.ts` run-length-encodes `@partybooth/contracts/qr`'s matrix instead, so the phone
> and the printed signage still go through one encoder.
>
> **Push** follows the current Expo docs (fetched, not remembered — `shouldShowBanner`/`shouldShowList`
> rather than the deprecated `shouldShowAlert`, and an explicit `projectId`). `expo-notifications` is
> reached through an adapter with a fake and is imported **dynamically**, so a build with no EAS
> project never evaluates it and the empty-environment export stays clean. The permission prompt is
> armed by a **successful join** and fired on the effect that follows — never at launch, because iOS
> gives one prompt per install and spending it on the splash screen buys a refusal that cannot be
> revisited. Sign-out gives the token back *before* the session goes (`push.unregisterDevice` is
> authenticated), and never blocks the sign-out if it cannot. A tap switches to the party the
> notification names and then navigates: upload trouble → My media, party opened → Camera, host
> queue → Host tab. Settings gained per-category toggles and the threshold picker, both wired to
> `push.preferences` / `push.updatePreferences`, with the host category hidden from somebody who
> hosts nothing.
>
> **Contract-change request (applied, and it is a cross-package edit worth reviewing):**
> `packages/backend/src/client-api.ts` had no `invites` or `push` section, so the typed client view
> did not describe the two function groups Sprint 5 added for clients. Both were added there rather
> than restated in each app, which is that file's own rule. **Still outstanding:** the notification
> `data` payload (`kind` / `eventId` / `transition` / `captureId`) is written by
> `convex/lib/notifications.ts` and parsed by `apps/mobile/src/push/routing.ts` from a restated
> shape — it should be hoisted into `@partybooth/contracts/push` so the two halves of the routing
> table cannot drift.
>
> **Owner-action item (mobile):** `EXPO_PUBLIC_EAS_PROJECT_ID` must be set in the **app's** build
> environment as well as `EAS_PROJECT_ID` on Convex. Without it the app registers no device and
> Settings says so in plain words; with only the Convex half set, the server queues notifications
> for devices that were never registered.

> **Web status (Sprint 5).** `apps/web` is code-complete for co-host management, rotation and the
> **full** `/admin` console — four routes under the existing shell (`/admin`, `/admin/accounts`,
> `/admin/events`, `/admin/audit`) rather than tabs, so an admin looking at a locked account can send
> somebody a link. **381 web tests** (was 321). Every privileged action goes through one
> `ConfirmAction` dialog: consequences listed before the field, confirm dead until `adminReasonSchema`
> parses, and the typed reason survives a failure. Which buttons a row offers is read off
> `accountStateMachine` rather than a local `switch`, and the audit viewer imports no mutation at all,
> so it is read-only by construction. Nothing under `components/admin/` renders an image.
>
> **Two live bugs found and fixed, both RC5-blocking.** (1) A co-host could not open the web console
> at all — `isOrganiserAuthorised` demanded `isOrganiser`, which accepting a co-host invitation
> deliberately does not set, so RC5's "second account as co-host moderates" was bounced out of
> `/media` before it started. Console access and `platform.createEvent` have consequently come apart,
> so "New event" is now gated separately on both the dashboard button and `/events/new`. (2) Any
> signed-in non-organiser — including every locked account — hit an infinite redirect between `/` and
> the organiser layout; both now ask the same four-valued gate.

> **Integration (Sprint 5).** Merged on `feat/sprint5` with the gate green: **2039 tests**
> (contracts 505, backend 627, web 381, mobile 489, env 37), `pnpm typecheck`, `pnpm lint`,
> `pnpm format:check`, plus `next build` and `expo export --platform all` with an **empty**
> environment.
>
> Four duplications were reconciled into `@partybooth/contracts` rather than left to drift:
>
> - **The notification routing payload.** The backend wrote the `data` bag as string literals and the
>   app parsed it from a hand-copied list of kinds. Both halves are now
>   `uploadStatusPayload`/`eventLifecyclePayload`/`pendingThresholdPayload` and `parsePushPayload`,
>   pinned by a builder→parser round-trip test.
> - **The push message copy.** `contracts/push.ts` had exported `uploadFailedMessage` and four
>   siblings since the sprint began and **nothing imported them** — the backend restated all five
>   inline. It now calls them.
> - **The rotation consequence copy.** `ROTATION_CONSEQUENCES` moved to `contracts/codes.ts` beside
>   the budget it describes; the console and the Host tab now render the same sentences for the same
>   irreversible choice.
> - **The `cohosts` and `admin` wire shapes** moved from `apps/web/src/lib/convex-api.ts` into
>   `packages/backend/src/client-api.ts`, which is that file's own stated rule. The web seam is a
>   seam again and describes no wire shape.
>
> **One bug found while verifying the Expo API against the live docs.** `InvalidProviderToken` was
> missing from `ExpoPushErrorCode`, and more seriously the three *project-credential* errors were
> exempt from token pruning but **not** from the failure counter — so a rotated APNs key, which fails
> for every device at once, would have disabled the entire push table on the third send. That is the
> outcome the pruning list is deliberately narrow to avoid, reached slowly instead of immediately.

> **Audit fixes (Sprint 5).** An audit of the merged sprint found twelve issues; all of the critical
> and major ones and most of the minor ones are fixed on `feat/sprint5`. Grouped by what they were
> really about:
>
> - **The freeze did not reach authorised uploads.** See the RC5 note above. `lockAccount` now sweeps
>   account-wide *and* per-owned-event, `scheduleAccountDeletion` sweeps too (so the console's "access
>   is revoked immediately, exactly as a lock does" is finally true of both routes, and the
>   self-service deletion path inherits it), and `completeUpload` discards bytes that arrive for a
>   frozen party.
> - **The admin console could pivot into a stranger's gallery.** `event.viewInviteCode` served global
>   admins the **QR token**, a 160-bit bearer credential sufficient to call `join.join`; the resulting
>   `guest` membership outranks the admin role in `resolveEventRole`, so `media.viewApproved` would
>   have succeeded and the console's defining "no media access" would have been one join away from
>   false. `invites.current`, `events.home` and `admin.rotateEventCode` now serve the code and never
>   the token, and `join`/`previewByCode` refuse an allowlisted address a **new** membership in an
>   event it does not own — the same shape as `assertDemoConfinement`. Two barriers, because either
>   alone is one edit from being removed.
> - **A removed co-host could restore their own seat.** `memberships.revokedByRotation` was only ever
>   set, never cleared or overwritten, so a row that had once been swept still read as a *sweep* after
>   a host's deliberate *removal* — and `join.admit` inherited the row's old `role`, handing back the
>   moderation queue and `event.rotateInvite` off a QR on a wall. The flag now means "swept and not
>   since re-decided": matching clears it, both removal mutations write `false`, `admit` re-derives
>   the role (a scan is worth a `guest` seat and nothing more), and a guest sitting in the swept state
>   can now be banned at all, which they could not before.
> - **Push retries did not exist.** Re-verified against
>   <https://docs.expo.dev/push-notifications/sending-notifications/>: network errors, 429s and 5xx
>   responses want exponential backoff, and so does a `MessageRateExceeded` ticket. All four now bump
>   an attempt counter, set `nextAttemptAt` and book their own retry, bounded at five attempts; a
>   non-retryable 4xx drops the chunk instead of retrying a request the service will always refuse.
>   Receipt checking was one-shot and now re-books itself, retires a ticket once Expo's 24-hour
>   receipt window elapses, and walks `sent` rows by send time — without retirement, permanently-stuck
>   rows filled the sweep's window and starved newer `DeviceNotRegistered` receipts out of it.
> - **Device health blamed the phone for things that were not the phone.** `MessageTooBig` is a defect
>   in the copy we composed and fails identically for every device, so it no longer counts; and a
>   later delivery success no longer clears `disabledAt`, because Expo's instruction for
>   `DeviceNotRegistered` is to stop sending "until it re-registers with your server".
>   `registerDevice` is now the only path that switches a token back on. Party names are also
>   sanitised before they reach a lock screen — an event name is free text and a newline in one let
>   its author compose what reads as a second sentence from PartyBooth.
> - **Inviting an organiser had no confirmation step**, which contradicted both PLAN.md and this
>   file's own claim that every privileged admin action goes through `ConfirmAction`. It does now.
> - **Signed read URLs cannot be revoked**, so the mitigation is the clock and the copy. The three
>   host-only surfaces that serve `pending` originals (`moderation.pending`, `moderation.flagged`,
>   `stats.recentSubmissions`) now mint 60-second URLs instead of ten-minute ones; the approved
>   gallery keeps the ten minutes, because there the exposure is content the member was legitimately
>   shown and a slideshow must not blink. The removal and lock copy state the residual window rather
>   than implying access stops instantly.
>
> **One finding rejected, with reasons.** `registerDevice` still reassigns a `pushDevices` row on a
> bare token match, so anyone who learns a victim's Expo push token can take the row over. Both
> proposed fixes are more than a fix: (a) letting two rows hold one token breaks the `by_token`
> `.unique()` read and delivers the same device two accounts' notifications until the prune lands,
> which is worse than the bug; (b) binding registration to an installation id needs a new field on the
> mutation, on `pushDevices`, and a matching change in `apps/mobile`, which is a **contract change**
> and is recorded as one below rather than smuggled into a fix pass. The message-composition half of
> that finding *is* fixed — see the sanitising above — so the remaining exposure is silence rather
> than attacker-controlled text.

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

## 📋 Notes for Corey — everything between this codebase and a tested party

*(Consolidated at end of 28 Jul from all five sprint gates. Sprints 1–5 are code-complete, audited and merged on `main` — 2,071 tests, every gate green with an empty environment. Nothing below is code; it is accounts, keys, deploys and holding real phones. `.env.example` is the authoritative variable list with per-variable comments — this section is the order to do things in.)*

### Phase A — accounts (third-party clocks; do first)

- [ ] **Play Console** account — starts the 14-day production-access clock (internal testing works immediately)
- [ ] **Apple Developer** membership active; App ID / bundle `com.partybooth.app`; a **Services ID** for Sign in with Apple
- [ ] **UploadThing** app: paid plan, region **pdx1**, default ACL **Private**, and **per-request ACL override enabled** (the route handler declares `acl: "private"` in code)
- [ ] **Convex** project, **US East (N. Virginia)** — dev + prod deployments
- [ ] **Resend** domain + DNS records (SPF/DKIM propagation takes hours — early is cheap)
- [ ] **Vercel** project (Root Directory `apps/web`, "Include source files outside of the Root Directory" ON), **Sentry** project, **Google OAuth** client
- [ ] Buy/confirm the **domain** for QR universal links (feeds `SITE_URL` and the printed signage)
- [ ] **GitHub repo** + `git remote add` + push `main` — CI is authored but has never run

### Phase B — wire and deploy the web/backend half

- [ ] `npx convex dev` once from `packages/backend` — pushes the schema and replaces the generic `_generated` fallback with real types
- [ ] Set env vars per `.env.example`. The ones with sharp edges:
  - `BETTER_AUTH_SECRET` — **identical** in Convex and Vercel, ≥32 chars
  - `BETTER_AUTH_URL` = the **`.convex.site`** origin, *not* your Vercel domain
  - `APPLE_CLIENT_ID` = the **Services ID**; `APPLE_APP_BUNDLE_IDENTIFIER` = `com.partybooth.app` — do not swap
  - `UPLOADTHING_TOKEN` in **both** Vercel and Convex; `UPLOAD_CALLBACK_SECRET` **same value both sides**
  - `SITE_URL` / `NEXT_PUBLIC_SITE_URL` / `EXPO_PUBLIC_SITE_URL` = the canonical domain (the QR encodes it — a preview hostname loses the app hand-off)
  - `ADMIN_EMAIL_ALLOWLIST` must contain **your** address — organiser access is invitation-gated, and without this RC1 sign-in shows you nothing
  - `DEPLOYMENT_ENVIRONMENT=production` + `NODE_ENV=production` on prod Convex — otherwise the console email sender and auth guards stay in dev mode
- [ ] `vercel link` + deploy; confirm **`/privacy`, `/terms`, `/account/deletion` resolve on the live domain** (App Review auto-rejects a dead privacy URL; Play's data-safety form needs the deletion URL)
- [ ] `APPLE_TEAM_ID` + `ANDROID_CERT_FINGERPRINTS` (Play Console → Setup → App signing → **SHA-256 of the Play-signed key, not the upload key**) so `/.well-known/` association routes go live, then `pnpm verify:app-links https://<domain>` — **before printing signage**; phones cache what they fetch at install time

### Phase C — the mobile half

- [ ] `eas init` → sets `EAS_PROJECT_ID`; put it on **Convex** AND `EXPO_PUBLIC_EAS_PROJECT_ID` in the **app build env** — setting only one half silently breaks push delivery. Optional: `EXPO_ACCESS_TOKEN`
- [ ] `npx expo prebuild --clean` once (materialises the expo-notifications Android metadata)
- [ ] EAS **development build** → install on your phone (this is the RC1 app half)

### Phase D — verify the RCs (the actual testing, in order)

- [ ] **RC1:** live Vercel URL → request OTP → real email arrives → sign in → organiser shell. App build opens on your phone.
- [ ] **RC2:** create event on desktop → scan QR with phone → join as guest (Google) → second phone joins by typed code.
- [ ] **RC3:** photo via **app** and via **web capture** both land `pending` on the organiser's media page in seconds; withdraw removes it; second guest can't fetch it.
- [ ] **RC4:** solo mini-party — phone uploads photo + video → approve on laptop → both appear on the TV slideshow live.
- [ ] **RC5:** two accounts, two phones — co-host moderates from their phone; rotate the code mid-event and confirm the old QR is dead; lock the organiser from `/admin` and watch everything freeze (including in-flight uploads).

### Phase E — store submissions (owner-only; each has a full walkthrough)

- [ ] iOS: set `DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_OTP` + `DEMO_LOGIN_EXPIRES_AT` on **prod** Convex, `pnpm seed:demo` with 2–3 uploaded asset keys, then follow [`docs/store/ios-submission.md`](docs/store/ios-submission.md) end to end (`APPLE_ID`, `ASC_APP_ID` for `eas submit`). Unset all three demo vars after approval.
- [ ] Android: [`docs/store/android-internal.md`](docs/store/android-internal.md) → internal-testing track → grab the opt-in link.

Done when: all five RC boxes above are ticked — then Sprint 6 (hardening + dress rehearsal) starts.
