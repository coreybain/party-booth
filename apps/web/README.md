# `@partybooth/web`

The Next.js 16 (App Router) site. It hosts three audiences from one codebase:

| Audience           | Routes                                                           | Status                                       |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------- |
| Organiser          | `/` (sign in), `/dashboard`, `/slideshow`, `/media`, `/settings` | Sprint 1: shell only                         |
| Global admin       | `/admin/login`, `/admin`                                         | Sprint 1: shell only                         |
| Guest (mobile web) | `/join`, `/join/<token>`                                         | Sprint 1: shell only, Sprint 2–3 fills it in |

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
  join/, join/[token]/        code entry + universal-link target
  api/auth/[...all]/          Better Auth ↔ Convex proxy
  error.tsx, global-error.tsx, not-found.tsx

src/components/
  providers.tsx               ConvexReactClient + ConvexBetterAuthProvider
  otp-sign-in-form.tsx        the whole OTP request/verify flow
  join-code-form.tsx          six-digit event-code entry
  layout/                     AppShell, CentredPane, Card, nav, event switcher
  ui/                         Button, TextField, CodeField, Callout

src/lib/
  auth-client.ts              Better Auth browser client (convex + emailOTP plugins)
  auth-server.ts              server-side session checks + route handler
  backend.ts                  "is a backend configured?" — used everywhere
  contracts.ts                ⚠️ seam for @partybooth/contracts (see the file)
  otp.ts                      email/code input helpers          (tested)
  sentry-scrub.ts             PII + secret scrubbing            (tested)
  sentry-options.ts           shared Sentry.init options
  cn.ts                       class-name joiner                 (tested)
```

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
