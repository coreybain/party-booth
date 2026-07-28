# `@partybooth/mobile`

Expo app for PartyBooth — iOS 17+ / Android 10+, **dev-client only** (never Expo Go).

Sprint 1 built the skeleton: navigation shell, auth wiring, providers, config.
**Sprint 2 makes it a real client** — onboarding that saves, joining by QR or code,
multiple memberships with a server-backed active event, and the Host tab appearing for
whoever the backend says is a host. Sprints 3–4 added the camera, the durable upload queue,
video, the galleries and the App Review flows. **Sprint 5 finishes the host's side**: the
Host tab is real (code, QR, rotation, party controls, the pending queue), and Expo push
covers upload trouble, a party opening or closing, and a host's queue building up.

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
  index.tsx               entry gate: config → session → onboarding → parked invite → tabs
  (auth)/sign-in.tsx      Apple + Google buttons
  (auth)/onboarding.tsx   name + photo confirmation — saves the name for real
  (tabs)/_layout.tsx      tab shell; renders the event header; Host tab is conditional
  (tabs)/camera.tsx       the viewfinder: CameraView, tap/hold shutter, flash/torch, undo pill, library
  (tabs)/photos.tsx       My media (queue + media.myMedia, merged) and the approved gallery
  (tabs)/host.tsx         code + QR, rotation modal, party controls, pending queue; re-checks the role
  (tabs)/settings.tsx     profile, notifications, blocked people, privacy policy, deletion, sign-out
  events.tsx              event switcher (modal): list, select, join another
  join/index.tsx          six-digit code entry (modal)
  join/[token].tsx        deep-link target for QR / partybooth:// / parked invite
src/
  env.ts                  the only place process.env is read
  lib/api.ts              typed seam over the Convex API — the one cast
  lib/                    pure, unit-tested logic + client singletons
  lib/shutter.ts          the tap-vs-hold gesture, as a pure state machine
  hooks/                  useJoinEvent, useNow, useCapture, useShutter
  providers/              Convex + Better Auth + session/membership context
  push/                   registration timing, tap routing, the expo-notifications adapter
  upload/                 the durable queue: reducer, engine, persistence, transport
  components/, theme/     presentational primitives and tokens
  test/                   jsdom screen + hook tests (react-native → react-native-web)
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

### Hold-to-record is a state machine, and the `arming` phase is not optional

`expo-camera` records only in `mode="video"`, and **changing `mode` tears down and rebuilds
the capture session**. So a naive "on long press, call `recordAsync`" fails on any device
slow enough to still be reconfiguring — intermittently, and worse on cheaper phones.

The gesture is therefore `idle → pressed → arming → recording → stopping`, in
`src/lib/shutter.ts`, pure and unit-tested in Node:

- `pressed` is the ambiguity. A release here is a photograph. The threshold is **250 ms**,
  shorter than RN's 500 ms `delayLongPress` default, because below ~200 ms you get videos
  from people trying to take a picture and above ~350 ms the button feels dead.
- `arming` flips the mode and **waits for `onCameraReady` to fire again** before recording.
  No guessed delay anywhere. This is also what makes the 60-second ring honest: it starts
  when the recorder started, not when the finger landed, so the minute a guest watches is
  the minute they get.
- `stopping` exists so a second release, a late tick, or a guest jabbing the button while
  the file finalises cannot open a second recorder on one session.

`useShutter` (`src/hooks/use-shutter.ts`) holds the machine and performs its effects
against a **structural** two-method camera interface. That split is what makes any of it
testable: `react-native-web`'s `Pressable` routes `onPressIn`/`onPressOut` through its
responder system, which needs a real pointer pipeline and does not fire under jsdom — a
screen test can render the shutter and can never press it. Behind the hook, the presses
are function calls. See `src/test/use-shutter.test.tsx`.

### Derivatives are produced here, not on the server

ADR 0008. Convex's isolate cannot host an image pipeline and a server-side step would have
to store the GPS-bearing original before it could strip anything, so the same re-encode
that already drops the EXIF block also produces what the party is served:

| media | uploaded as `original` | uploaded as derivative        | local only         |
| ----- | ---------------------- | ----------------------------- | ------------------ |
| photo | 4096 px JPEG re-encode | `preview` — 1280 px JPEG      | 640 px thumbnail   |
| video | the recorded clip      | `poster` — 1280 px JPEG still | (poster is reused) |

Each derivative is a **separate grant under the same `captureId`** with a distinct
`fileRole`, held to its own 2 MiB cap, and **refused unless it claims the re-encode** — on
a derivative `sourceMetadataStripped` is a precondition rather than a record, because the
derivative is what third parties are served. In the queue they are a `derivatives[]` array
on the row rather than rows of their own, so one capture stays one submission, and they are
attempted only _after_ the original has landed.

A video's `preview` role — a downscaled muted clip — is **not** produced: that needs a
transcoder this platform does not have. `projectMedia` falls back to the poster, so the
cost is bandwidth on a grid rather than visibility. Post-launch (PLAN.md → P2).

Video posters come from `expo-video`'s `player.generateThumbnailsAsync`, which returns a
native `SharedRef<'image'>` rather than a file — that goes straight into
`ImageManipulator.manipulate`, so the poster is a genuine re-encode from decoded pixels and
comes out as a JPEG with a size and a checksum. `expo-video-thumbnails` is deprecated and
was not added.

**One honest caveat, written down rather than buried:** a 60-second clip cannot be
re-encoded on a phone in the time a guest will wait, so the video original is uploaded as
the recorder wrote it.

The flag that used to have to cover this was split during Sprint 4's integration pass, which
was exactly the contract-change request this paragraph used to end with. The clip now claims
`sourceMetadataStripped: false` — truthfully, nothing was transcoded — and
`sourceCarriesNoLocation: true`, justified structurally rather than mechanically: the app holds
**no location permission on either platform** (`blockedPermissions` on Android, no `NSLocation*`
on iOS), so there is no fix for the recorder to embed, and video library import is deliberately
not built, so the one file type that could arrive carrying somebody else's GPS trace has no
route in. The read path reads the second flag, so the clip is still shown to fellow guests —
the difference is that the sentence is now true. See `buildVideoCapture` in
`src/upload/media-pipeline.ts` and `MetadataClaim` in `@partybooth/contracts/media`.

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

### The Convex API is typed by hand, in the backend

`convex codegen` can only emit the **generic** `AnyApi` until a real deployment exists to
introspect, and under `AnyApi` every function reference has `any` arguments and an `any`
result. That would put a typo'd function name, a renamed field or a newly-required
argument on a phone before the compiler ever saw it.

So `@partybooth/backend/client-api` declares the shape of the calls the clients make and
casts the generated object to it **once**. It lives in the backend rather than here
because `apps/web` needs the same description, and two hand-written copies of one wire
contract is a drift bug that fails silently — they had already disagreed about whether
`storageRegion` was a `string`. `src/lib/api.ts` is this app's one-line view onto it, so
no screen imports the backend directly. Payload types are assembled from
`@partybooth/contracts` wherever a definition already exists there (`EventState`,
`EventRole`, `JoinResult`, `StorageRegion`); only the field lists, which the backend's
`v.object(...)` validators own, are restated.

The residual risk is a backend `returns` validator changing without that file following.
Two things contain it: `join.join`'s result is re-parsed at the call site with the
contract's own `parseJoinResult` (a cast asserts a shape, parsing proves it), and
`client-api.ts` collapses to a re-export of `_generated/api` the moment `convex dev` has
run against a deployment — no screen changes when it does.

### `expectAuth` is off, and Sprint 1 had it on

`ConvexReactClient`'s `expectAuth` pauses the socket until the first auth token arrives.
`ConvexProviderWithAuth` only calls `setAuth` when the provider reports _authenticated_,
so for a signed-out user the socket never resumes and **no query runs at all**.

That was invisible in Sprint 1, where every query was authenticated. Sprint 2 has one
that must not be: `join.previewByToken` is unauthenticated on purpose, so a guest who
scans the QR sees whose party it is before deciding to sign in. With `expectAuth: true`
that screen hangs on a spinner, on the most important path in the product.

The flash it was avoiding is prevented properly instead — `LiveSessionProvider` gates
every authenticated query on `useConvexAuth().isAuthenticated`, which is _stricter_: it
also closes the window where Better Auth has a session but Convex has not been told yet,
in which `events.myEvents` would have thrown `unauthenticated` during render.

### The photo is remembered locally; the name is not

Onboarding's name goes to Convex through `users.updateProfile`, which is the **one** writer
of `users.displayName` — the column the host's queue and every audit row read, and the same
mutation `apps/web`'s name-confirm form calls. It also stamps `users.onboardedAt`, which is
what `needsOnboarding` reads: a reinstall no longer re-prompts, and a guest who confirmed
their name on the web is not asked again here.

The **photo** stays on the device (`src/lib/local-profile.ts`, via `expo-secure-store`,
which is already linked for the session cookie). A `file://` path stored on the server is
a string no other device can resolve, and avatars ride the same short-lived upload-grant
pipeline as party media, which Sprint 3 builds. A second ad-hoc upload path now is one to
delete next week. `updateProfile` already takes `avatarKey`, so when the pipeline exists
the only change here is passing it.

### Push notifications

`expo-notifications` is reached through an **adapter** (`src/push/adapter.ts`) with a fake,
and the real one imports the native module **dynamically**. Two things fall out of that,
both required: the registration lifecycle is testable offline with no device, and a build
with no `EXPO_PUBLIC_EAS_PROJECT_ID` never evaluates the module at all — which is what
keeps `expo export` green with an empty environment.

The API surface was checked against the current docs rather than remembered: the
foreground handler returns `shouldShowBanner`/`shouldShowList` (the old `shouldShowAlert`
is deprecated and silently draws nothing on iOS), and `getExpoPushTokenAsync` is passed an
explicit `projectId`.

**The permission prompt is armed by a successful join, not by a launch.** iOS grants one
system prompt per install; spending it on the splash screen buys a refusal from somebody
who does not yet know what the app is, and it can never be revisited from inside the app.
`useJoinEvent` calls `armPrompt()`, the flag is persisted, and `PushProvider` asks on the
effect that follows. Settings offers the way back for anybody who declined.

Sign-out hands the token back **before** the session is torn down — `push.unregisterDevice`
is authenticated — through the one-slot registry in `src/push/detach.ts`, because the
provider that holds the token is mounted below the session provider that owns `signOut`.
It never blocks a sign-out: a stale device row goes quiet by itself on the next
`DeviceNotRegistered`, and being unable to sign out does not.

### Testing

`pnpm --filter @partybooth/mobile test` runs Vitest in **two projects** (see
`vitest.config.ts`):

- **`mobile`** — plain Node, no React. `src/lib`, `src/push` and `src/upload`: deep links,
  join-result handling, event state and schedule copy, roles and the host capability table,
  the durable queue's reducer/engine/backoff, when to ask for notification permission, and
  where a tapped notification goes. Everything decidable with values lives here and takes
  `now` as an argument.
- **`mobile-screens`** — jsdom with `react-native` aliased to `react-native-web`, so the
  screens under test are the real screens. This project exists because of Sprint 3's
  expensive lesson: `use-capture` was green while being imported by nothing at all, and no
  test in the package could have noticed. It catches "the screen renders no `CameraView`",
  "the Host tab shows a guest the invite code" and "the rotation modal does not pass the
  host's choice to the mutation".

Neither pretends to cover anything needing a real camera or a real APNs token; the
two-physical-phone pass in Sprint 6 is what proves those.

Screen logic is kept testable by being pushed _out_ of the screens: a screen should read
as a list of states, with every decision behind a named function in `src/lib`. The join
copy is the sharpest case — `describeJoinFailure` has a test asserting it shows the
contract's single rejection sentence, so a well-meaning "be more helpful here" change
fails a test instead of quietly becoming an enumeration oracle.

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
