# @partybooth/env

Typed, **lazily-validated** environment access. Zod 4 schemas; no `@t3-oss/env-*` dependency
because we need one behaviour it does not offer: a missing variable must only blow up when the
code that needs it actually runs, so an unconfigured provider never breaks an unrelated page.

## Entry points

| Import                   | Use from                                            |
| ------------------------ | --------------------------------------------------- |
| `@partybooth/env/server` | Convex functions, route handlers, server components |
| `@partybooth/env/client` | `apps/web` browser code (`NEXT_PUBLIC_*`)           |
| `@partybooth/env/mobile` | `apps/mobile` (`EXPO_PUBLIC_*`)                     |
| `@partybooth/env`        | primitives + schemas only — no values               |

The barrel deliberately does **not** re-export `serverEnv`, so client code cannot accidentally
pull secrets into a bundle. `serverEnv` additionally throws `ServerEnvAccessError` if it is ever
read where `window.document` exists.

## Reading a value

```ts
import { serverEnv } from "@partybooth/env/server";

const apiKey = serverEnv.RESEND_API_KEY;
// Unset → MissingEnvError:
//   [@partybooth/env] Missing required server environment variable RESEND_API_KEY.
//     Where it comes from: Resend dashboard → API Keys → Create API Key (sending permission).
//     Set it in: .env.local for local dev, the Convex dashboard for Convex, …
```

Nothing is read at import time. Values are memoised after first read.

## Degrading gracefully

Never `try/catch` a missing variable — ask first:

```ts
import { serverEnv, serverFeatures } from "@partybooth/env/server";

export async function sendOtp(to: string, code: string) {
  if (!serverFeatures.resend) {
    console.warn("[email] Resend is not configured; logging the OTP instead.");
    console.warn(`[email] OTP for ${to}: ${code}`);
    return { delivered: false as const };
  }
  // …use serverEnv.RESEND_API_KEY
}
```

`serverFeatures` covers `sentry`, `sentrySourceMaps`, `resend`, `googleOAuth`, `appleOAuth`,
`uploadthing`, `expoPush` and `demoLogin`. Every getter is total — it never throws.

Lower-level helpers, all exported from `@partybooth/env`:

| Helper                  | Behaviour                                                            |
| ----------------------- | -------------------------------------------------------------------- |
| `envHas(env, key)`      | `boolean`, never throws                                              |
| `envHasAll(env, keys)`  | `boolean`, never throws                                              |
| `envOptional(env, key)` | value or `undefined` when unset; still throws on a _malformed_ value |
| `envAssert(env, keys)`  | eager check, one aggregated error listing every problem              |
| `describeEnv(env)`      | per-variable report (key/hint/required/present/valid) — no values    |
| `resetEnvCache(env)`    | drop memoised results; tests only                                    |

`envAssert` is the right thing to call at the top of a route handler or Convex action that needs
several variables at once — one clear error instead of a cascade.

## Bundler gotchas (read this before wiring an app)

Public variables are inlined by **literal text substitution**, so they must be written out one
key at a time. That is already done in `client.ts` / `mobile.ts` — but:

- **`apps/web`** must add this package to `transpilePackages` in `next.config.ts`, otherwise
  Next.js will not substitute inside it:
  ```ts
  transpilePackages: ["@partybooth/env", "@partybooth/contracts"],
  ```
- **`apps/mobile`** should call `createMobileEnv({...})` from its **own** source.
  `babel-preset-expo` skips `node_modules` when inlining `EXPO_PUBLIC_*`, and a workspace
  package lives in `node_modules` as far as Metro is concerned. See the doc comment on
  `createMobileEnv` for the exact snippet.

## Adding a variable

1. Add it to `src/schema.ts` (`serverVars`, `clientVars` or `mobileVars`) with a `hint` that
   says **where Corey gets the value**.
2. Add it to `/.env.example` with a comment line directly above it.
3. `pnpm --filter @partybooth/env test` — the suite fails if the two drift apart, if a public
   variable is missing its `NEXT_PUBLIC_`/`EXPO_PUBLIC_` prefix, or if a hint is too vague.

`pnpm env:doctor` prints which variables are still unset, with the hint for each one. It never
prints values.
