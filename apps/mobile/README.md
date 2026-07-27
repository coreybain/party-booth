# `@partybooth/mobile`

Expo app for PartyBooth — iOS 17+ / Android 10+, **dev-client only** (never Expo Go).

Sprint 1 scope is the skeleton: navigation shell, auth wiring, providers, and config.
Camera, uploads, moderation and push land in Sprints 3–5.

## Quick start

```bash
cp apps/mobile/.env.example apps/mobile/.env.local   # optional — the app runs without it
pnpm --filter @partybooth/mobile dev                 # expo start --dev-client
```

Without a `.env.local` the app boots to a **"PartyBooth isn't configured"** screen listing
the missing variables and where each value comes from, with a button to explore the shell
anyway. That is deliberate: nothing in this app requires live credentials to build, run,
typecheck or test.

### This is a dev-client app, not Expo Go

`expo-camera`, `expo-secure-store`, `expo-apple-authentication` and `expo-notifications`
all need native code that Expo Go does not carry. Build a dev client once per native
change:

```bash
pnpm --filter @partybooth/mobile eas:build:dev      # device
pnpm --filter @partybooth/mobile prebuild           # or build locally
```

## Layout

```
app/                      Expo Router routes (file-based)
  _layout.tsx             Sentry init, providers, root Stack
  index.tsx               entry gate: config → session → onboarding → tabs
  (auth)/sign-in.tsx      Apple + Google buttons
  (auth)/onboarding.tsx   name + photo confirmation shell
  (tabs)/_layout.tsx      tab shell; Host tab is conditional
  (tabs)/camera.tsx       placeholder + live permission status
  (tabs)/photos.tsx       My media / Event gallery empty states
  (tabs)/host.tsx         host scaffold, re-checks the role itself
  (tabs)/settings.tsx     profile stub, sign-out, diagnostics
  join/[token].tsx        deep-link target for QR / partybooth:// / code
src/
  env.ts                  the only place process.env is read
  lib/                    pure, unit-tested logic + client singletons
  providers/              Convex + Better Auth + session context
  components/, theme/     presentational primitives and tokens
```

## Decisions

### Expo SDK 57

Current stable. SDK 57 is the React Native 0.86 release and Expo state it is "intended to
have no breaking changes from 0.85", so the usual reason to lag a release (churn) does not
apply. Every module this app needs ships a stable 57.x. `npx expo-doctor` passes 20/20 —
keep it that way; it catches native version drift that only surfaces during an EAS build.

`@sentry/react-native` is pinned to `~7.11.0` rather than the newer 8.x specifically
because 7.11 is what SDK 57 validates against. A major-version mismatch on the crash SDK
is exactly the kind of thing that fails an iOS build on submission day.

### Camera: `expo-camera`, not `react-native-vision-camera`

Launch scope is a **clean camera** — tap for photo, hold for video (≤60 s), flash, flip,
both orientations (PLAN.md → "Camera"). `expo-camera`'s `CameraView` covers all of it:
`mode="picture" | "video"`, `recordAsync({ maxDuration })`, `flash`, `enableTorch`,
`facing`, plus `useCameraPermissions` / `useMicrophonePermissions`.

Why not vision-camera, given Sprint 4's hold-to-record requirement:

- **Version lock.** `expo-camera` is versioned with the SDK and validated by
  `expo-doctor`. vision-camera 5.x additionally pulls `react-native-nitro-modules` and
  `react-native-nitro-image`, none of which are SDK-pinned. Three unpinned native deps in
  a dev-client build, eight days before a hard date, is the wrong risk.
- **Effects are post-launch.** vision-camera's real advantage is frame processors — which
  is what Banuba/Skia effects need. PLAN.md defers all effects to P3, and already
  specifies a `CameraEffectsAdapter` seam for them.
- **The swap is cheap later.** Capture is confined to the Camera tab behind the upload
  queue's interface, so P3 can replace the implementation without touching the pipeline.

Revisit at P3, not before.

### Better Auth is mounted on Convex, so `baseURL` is the `.convex.site` origin

Better Auth runs on Convex HTTP actions, which are served from `*.convex.site` — not the
`*.convex.cloud` API origin and not the website.

`EXPO_PUBLIC_CONVEX_SITE_URL` is the explicit source of truth, mirroring how `apps/web`
reads `CONVEX_SITE_URL`. It is **optional**: when it is unset, `convexSiteUrlFrom()` in
`src/lib/config.ts` derives the value from `EXPO_PUBLIC_CONVEX_URL` by swapping
`.convex.cloud` for `.convex.site`, so a standard hosted deployment needs one fewer
variable. Set it explicitly for self-hosted or proxied Convex, where that naming
convention does not hold — the derivation returns such hosts unchanged, which would
point Better Auth at the wrong origin.

### Two upstream type casts

Both are narrow, commented in place, and worth re-testing on every dependency bump:

| Where                     | Why                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/auth-client.ts`  | `@better-auth/expo`'s `getActions` is declared method-style; the interface declares it as a property, so `strictFunctionTypes` rejects it. |
| `src/providers/index.tsx` | `@convex-dev/better-auth` types its `authClient` prop without `baseURL`, which every client in their own Expo guide passes.                |

Neither is a wiring error — the runtime objects are exactly what the libraries expect.

### Testing

`pnpm --filter @partybooth/mobile test` runs Vitest over `src/lib/**/*.test.ts` only —
the pure modules with no React Native imports (deep links, roles, config, Sentry
scrubbing). Rendering RN components under Vitest needs a Metro-equivalent transform and
native mocks, which is a poor trade this week; component behaviour is covered by the
two-physical-phone pass in Sprint 6.

The strongest offline check that the app actually works is `pnpm --filter
@partybooth/mobile build` (`expo export`) — it runs the real Metro graph and fails on any
unresolved import.

## Native config

Set in `app.config.ts`; `expo prebuild` turns it into the native projects.

| Item              | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Bundle id/package | `com.partybooth.app`                                                   |
| iOS minimum       | 17.0 (`expo-build-properties`)                                         |
| Android minimum   | API 29 / Android 10 (`expo-build-properties`)                          |
| Scheme            | `partybooth://`                                                        |
| Universal links   | `applinks:<host of EXPO_PUBLIC_SITE_URL>`, Android App Link on `/join` |
| Orientation       | `default` (both, per PLAN.md)                                          |

Purpose strings are declared **twice** on purpose — once via each config plugin and once
explicitly in `ios.infoPlist`. App Review rejects a build with a missing purpose string,
and a plugin regression should not be able to silently drop one.

Android `blockedPermissions` strips storage and location permissions that autolinked
libraries like to add. PartyBooth never reads arbitrary storage, and Play flags both as
sensitive.

## EAS

`eas.json` defines four profiles. **No EAS build has been run** — `eas init` still needs
to happen, which is what fills in `EXPO_PUBLIC_EAS_PROJECT_ID`.

| Profile                 | Use                                                                |
| ----------------------- | ------------------------------------------------------------------ |
| `development`           | dev client, internal distribution, Android APK                     |
| `development-simulator` | same, plus an iOS simulator build                                  |
| `internal`              | release build → TestFlight and the Play **internal testing** track |
| `production`            | store submission                                                   |

`appVersionSource: "remote"` means EAS owns build numbers; only `version` lives in
`app.config.ts`.

Before the first build:

1. `eas init` (writes the project id — put it in `.env.local` _and_ as an EAS env var)
2. `eas credentials` for the iOS bundle id and the Android keystore
3. Fill the `submit` block's iOS fields (`ascAppId`, `appleTeamId`, ASC API key) — left
   empty here rather than filled with placeholders that would fail a real submit

## Assets

`assets/*.png` are **generated placeholders** — a lens mark in the brand palette, good
enough that the app does not look broken. Replace before store submission; the App Store
1024×1024 icon must have no alpha channel.
