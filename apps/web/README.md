# `@partybooth/web`

The Next.js 16 (App Router) site. It hosts three audiences from one codebase:

| Audience           | Routes                                                                                                               | Status                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Organiser          | `/` (sign in), `/dashboard`, `/events/new`, `/events/<id>`, `/events/<id>/edit`, `/slideshow`, `/media`, `/settings` | Sprint 4: moderation grid, slideshow, live home numbers        |
| Global admin       | `/admin/login`, `/admin`                                                                                             | Sprint 1: shell only                                           |
| Guest (mobile web) | `/join/<token>` (QR target), `/join` (code entry), `/event/<id>`                                                     | Sprint 4: join, photo **and video** capture, my media, gallery |
| Public             | `/privacy`                                                                                                           | Sprint 4: no account needed — App Review requires the URL      |
| Storage            | `/api/uploadthing` (presign + provider callback)                                                                     | Sprint 4: originals **and** derivatives                        |

### The join path

`/join/<token>` is the universal-link target the QR encodes, and the guest path
PLAN.md makes _guaranteed_ for 5 August. It shows the event first (the preview
query is unauthenticated — the token is 160 bits, so there is nothing to
enumerate), then Google or email-OTP sign-in in place, then a name confirmation,
then the join. `/join` is the typed-code fallback and reverses the first two
steps on purpose: resolving six digits is only safe from an authenticated,
throttled mutation.

Every refusal renders the same sentence, from `JOIN_REJECTED_MESSAGE` in
`@partybooth/contracts` — unknown code, superseded QR, event not open and
revoked membership must stay indistinguishable. Nothing in `src/components/join/`
may branch on that string.

### The upload path

Sprint 3, and the half of the guest journey that PLAN.md calls _guaranteed_.
Five hops, and the interesting thing about each one is which side is trusted:

| #   | Where                                | What happens                                                                                     |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | browser · `lib/upload/derivative.ts` | the chosen photo is **decoded and re-encoded** to JPEG ≤ 2560 px, plus a local 480 px thumbnail  |
| 2   | browser · `lib/upload/checksum.ts`   | SHA-256 of the **re-encoded** bytes — the value the grant is bound to                            |
| 3   | `POST /api/upload-grant` → Convex    | same-origin session bridge requests permission, policy checks and a two-minute single-use secret |
| 4   | `POST /api/uploadthing` · `core.ts`  | middleware re-checks the file against the ticket and the grant against Convex, then presigns     |
| 5   | UploadThing → `onUploadComplete`     | `media.completeUpload`, server-to-server, authenticated by `UPLOAD_CALLBACK_SECRET`              |

Four things in there are load-bearing and easy to undo by accident.

**The re-encode is the privacy control, not a size optimisation.** A camera JPEG
carries GPS to five decimal places, the device serial and the capture time in its
EXIF block. Decoding to a bitmap keeps only pixels, so the JPEG written back out
has no metadata to strip — there was never any written. ADR 0004 §7 chooses this
over server-side stripping precisely because the untouched original then never
exists anywhere but the guest's own phone. `buildPhotoDerivatives` **throws**
rather than falling back to the original bytes, and the grant carries
`sourceMetadataStripped` from the value the pipeline actually produced, never a
literal `true`.

**The middleware is a gate; Convex is the authority.** `.middleware()` calls
`media.confirmUpload` with the guest's own session, which proves the grant is
live, unexpired and theirs, and creates the `processing` media row so "My media"
has something to show immediately. It deliberately does **not** spend the grant:
single use is a serialisable read-decide-write inside `media.completeUpload`, and
a check in a route handler that a second request can race is not a check
(ADR 0004 §1). What the middleware adds is a refusal _before_ bytes cross a
party's wifi — a capture whose row is already settled comes back in a state other
than `processing`, and a replay is turned away with nothing stored.

**`acl: "private"` is declared in the route config**, not inherited from the
UploadThing dashboard default. An invariant that lives only in a dashboard
checkbox is one a mis-click silently revokes for every photo taken afterwards.

**Signed URLs are rendered with a plain `<img>`, never `next/image`.** Routing a
short-lived signed URL through `/_next/image` caches a decoded copy of a guest's
photograph on a shared CDN, keyed on the source URL and outliving the signature —
which recreates exactly the durable public URL the private ACL exists to prevent.
See `src/components/media/media-thumbnail.tsx`.

Two variables have to be set, in two different dashboards, and either being wrong
produces the same visible symptom — photos that reach storage and sit in
`processing` for ever. `/media` says so, in those words, from
`media.storageStatus`.

**Derivatives ride the same five hops** (Sprint 4, ADR 0008). A preview or a
poster is a _second_ single-use grant under the _same_ `captureId`, held to its
own 2 MiB cap, sent after the original has landed and refused unless it claims
the re-encode. Two places in `core.ts` know the difference: a derivative's media
row is legitimately already `pending` or `approved` (the original's rule would
refuse every one of them), and the byte cap comes from the role `confirmUpload`
returns rather than the role the ticket claims. Failure is silent by design — a
capture with no preview is a working capture, and the guest is told nothing about
an artefact that is not their submission.

**Video is sent as recorded.** There is no transcoder in a phone browser, so
`lib/upload/video.ts` reads the clip's length, refuses it over 60 s or 250 MB
before a byte moves, and draws a **poster** through the same canvas the photo
pipeline uses. The clip's own `sourceMetadataStripped` is `false`, truthfully,
which is why `mayServeOriginal` shows a fellow guest the poster and not the
video. The capture panel says so in as many words.

## Run it

```bash
bun run --filter @partybooth/web dev     # http://localhost:3000
bun run --filter @partybooth/web build
bun run --filter @partybooth/web test
```

Everything above works with **no environment variables at all**. With no
`NEXT_PUBLIC_CONVEX_URL` the app runs in **preview mode**: every screen renders,
the Convex provider is skipped, the auth gates let you through behind a banner,
and `/api/auth/*` answers 503 with an actionable message. Set `CONVEX_URL` and
`CONVEX_SITE_URL` and the gates go live and fail closed.

Run `bun run env:doctor` from the repo root to see what is still unset.

## Layout

```
instrumentation.ts            Sentry server/edge bootstrap + onRequestError
instrumentation-client.ts     Sentry browser bootstrap
sentry.{server,edge}.config.ts
next.config.ts                headers, transpilePackages, withSentryConfig
vercel.json                   framework + region (iad1, co-located with Convex US East)

src/app/
  layout.tsx                  <html>, metadata, viewport, providers, skip link
  page.tsx                    organiser OTP sign-in (site root)
  (organiser)/                authenticated organiser shell + four pages
  privacy/                    the public privacy policy — no shell, no auth
  admin/login/                admin OTP sign-in — reachable while signed out
  admin/(console)/            authenticated admin shell (distinct palette)
  (organiser)/events/         create, event home (code + QR), edit
  join/, join/[token]/        code entry + universal-link target
  event/[eventId]/            where a guest lands after joining
  api/auth/[...all]/          Better Auth ↔ Convex proxy
  api/upload-grant/           authenticated HTTP bridge for media.requestUploadGrant
  api/uploadthing/            core.ts = FileRouter · route.ts = handler (503 with no creds)
  error.tsx, global-error.tsx, not-found.tsx

src/components/
  providers.tsx               ConvexReactClient + ConvexBetterAuthProvider
  backend-gate.tsx            ⚠️ every Convex hook must render inside one
  otp-sign-in-form.tsx        the whole OTP request/verify flow
  join-code-form.tsx          six-digit event-code entry (presentational)
  qr-code.tsx                 inline SVG from the contracts QR encoder
  events/                     create/edit form, event home, invite panel, list
  guest/                      Google + OTP sign-in, name confirm, event view
  join/                       token flow, code flow, preview card, refusals
  guest/capture-panel.tsx     input[capture] → derivative → grant → upload
  guest/my-media.tsx          own submissions, status chips, retry/cancel/withdraw
  media/                      thumbnail + tile (poster, click-to-play), storage callouts
  moderation/                 the grid: cards, filter bar, flagged panel
  slideshow/                  the stage, one slide, the auto-hiding controls
  layout/                     AppShell, CentredPane, Card, nav, event switcher
  ui/                         Button, TextField, CodeField, Select, Choice, …

src/lib/
  auth-client.ts              Better Auth browser client (convex + emailOTP plugins)
  auth-server.ts              server-side session checks + route handler
  backend.ts                  "is a backend configured?" — used everywhere
  contracts.ts                ⚠️ seam for @partybooth/contracts (see the file)
  convex-api.ts               ⚠️ seam for @partybooth/backend/client-api
  app-errors.ts               ConvexError → one actionable sentence
  use-join.ts                 the one join controller, both doors
  join-url.ts                 which origin a join link is built on (tested)
  datetime.ts                 wall clock ↔ epoch, in the event's zone (tested)
  event-form.ts               form model + contract validation  (tested)
  event-view.ts               state copy, legal transitions     (tested)
  use-browser-time-zone.ts    hydration-safe Intl zone
  server-now.ts               `Date.now()` for Server Components only
  otp.ts                      email/code input helpers          (tested)
  sentry-scrub.ts             PII + secret scrubbing            (tested)
  sentry-options.ts           shared Sentry.init options
  cn.ts                       class-name joiner                 (tested)
  media-view.ts               status copy, server+local merge    (tested)
  moderation/
    filters.ts                what the grid shows, and in what order   (tested)
    selection.ts              selection, keyboard cursor, bulk counts  (tested)
    reports.ts                host-facing copy for a content report
  slideshow/
    machine.ts                order, advance, skip-on-failure          (tested)
    use-slideshow-feed.ts     cursored feed that accumulates
    use-wake-lock.ts          keep the television awake, re-acquired
  use-capture-upload.ts       the one capture controller
  use-now.ts                  render-safe wall clock (useSyncExternalStore)
  upload/
    ticket.ts                 the .input() payload + file cross-check  (tested)
    grant-transport.ts        HTTP grant bridge + fail-closed parser   (tested)
    derivative.ts             canvas re-encode, EXIF/GPS stripping     (tested)
    checksum.ts               SHA-256 over the re-encoded bytes
    capture-id.ts             unguessable idempotency key              (tested)
    machine.ts                the upload queue reducer                 (tested)
    video.ts                  duration probe + canvas poster frame     (tested)
    uploader.ts               genUploader bound to our FileRouter
    server.ts                 server-only: config + completeUpload
```

### Two seams and one gate

- **`src/lib/contracts.ts`** and **`src/lib/convex-api.ts`** are the only files
  that import `@partybooth/contracts` and `@partybooth/backend`. The typed
  function references live in `@partybooth/backend/client-api` — shared with
  `apps/mobile`, because offline `convex codegen` can only emit the generic
  `AnyApi` and two hand-written copies of one wire contract drift silently. That
  file becomes a re-export once a deployment exists; this seam does not change.
- **`useJoinAttempt`** (`src/lib/use-join.ts`) is the single join controller.
  `/join/<token>` and `/join` are two front doors onto one mutation, and having
  written the call out twice is how one copy acquires a more helpful error
  message and the join path becomes an enumeration oracle.
- **`BackendGate`** is structural, not cosmetic. With no `NEXT_PUBLIC_CONVEX_URL`
  there is no `ConvexBetterAuthProvider` in the tree, so `useQuery`,
  `useMutation` and `useConvexAuth` throw. An early `return` inside the
  component is too late — the hooks have already run. Any component calling a
  Convex hook must therefore be _rendered by_ a gate, not merely guarded inside
  one.

## Styling

Tailwind CSS v4, no component library. Every colour is a CSS variable declared
in `src/app/globals.css`; a subtree re-themes itself by overriding them, which
is how `data-shell="admin"` gives the admin console a distinct palette without a
second set of components.

Layout primitives (`AppShell`, `CentredPane`, `Card`) are deliberately free of
organiser/admin/guest specifics, because guest mobile-web capture lands in the
same app in Sprint 3.

## Sentry

Initialised **only** when a DSN is present, so nothing is sent — and no network
call is made — on a machine without credentials.

Two layers of protection:

1. `dataCollection` in `src/lib/sentry-options.ts` stops the SDK collecting
   cookies, query strings, request bodies, stack-frame locals and user info.
2. `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb` run
   `src/lib/sentry-scrub.ts`, which redacts emails, six-digit OTP and join
   codes, JWTs, bearer tokens, provider API keys, signed-URL query strings and
   `/join/<token>` path segments, and reduces `user` to an opaque id.

`sentry-scrub.test.ts` is the specification — 70+ assertions, all offline.

## Deploying (do not run this yet)

Vercel project settings:

- **Root Directory** `apps/web`, with "Include source files outside of the Root
  Directory" enabled (needed for the workspace packages).
- Framework preset **Next.js**; leave build and install commands on the
  defaults so Vercel's own Turborepo support applies.
- Environment variables: every `NEXT_PUBLIC_*` from `.env.example`, plus
  `CONVEX_URL`, `CONVEX_SITE_URL`, `BETTER_AUTH_*`, `RESEND_*`, `SENTRY_*`,
  `UPLOADTHING_TOKEN`, `UPLOADTHING_ACL`, and `UPLOAD_CALLBACK_SECRET` — the last one set to the
  **same value** here and in the Convex dashboard, or completion callbacks are
  refused and nothing ever leaves `processing`.
- The UploadThing app needs a paid plan, region `pdx1`, default ACL **Private**
  and **per-request ACL override enabled**, because the route config declares
  `acl: "private"` explicitly rather than trusting the dashboard default.
- `vercel.json` pins functions to `iad1` to sit next to the Convex US East
  deployment.
