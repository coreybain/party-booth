# `@partybooth/web`

The Next.js 16 (App Router) site. It hosts three audiences from one codebase:

| Audience           | Routes                                                                                                               | Status                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Organiser          | `/` (sign in), `/dashboard`, `/events/new`, `/events/<id>`, `/events/<id>/edit`, `/slideshow`, `/media`, `/settings` | Sprint 2: events, code + QR. Media Sprint 3–4 |
| Global admin       | `/admin/login`, `/admin`                                                                                             | Sprint 1: shell only                          |
| Guest (mobile web) | `/join/<token>` (QR target), `/join` (code entry), `/event/<id>`                                                     | Sprint 2: join works. Capture Sprint 3        |

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

## Run it

```bash
pnpm --filter @partybooth/web dev     # http://localhost:3000
pnpm --filter @partybooth/web build
pnpm --filter @partybooth/web test
```

Everything above works with **no environment variables at all**. With no
`NEXT_PUBLIC_CONVEX_URL` the app runs in **preview mode**: every screen renders,
the Convex provider is skipped, the auth gates let you through behind a banner,
and `/api/auth/*` answers 503 with an actionable message. Set `CONVEX_URL` and
`CONVEX_SITE_URL` and the gates go live and fail closed.

Run `pnpm env:doctor` from the repo root to see what is still unset.

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
  admin/login/                admin OTP sign-in — reachable while signed out
  admin/(console)/            authenticated admin shell (distinct palette)
  (organiser)/events/         create, event home (code + QR), edit
  join/, join/[token]/        code entry + universal-link target
  event/[eventId]/            where a guest lands after joining
  api/auth/[...all]/          Better Auth ↔ Convex proxy
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
  `CONVEX_URL`, `CONVEX_SITE_URL`, `BETTER_AUTH_*`, `RESEND_*`, `SENTRY_*`.
- `vercel.json` pins functions to `iad1` to sit next to the Convex US East
  deployment.
