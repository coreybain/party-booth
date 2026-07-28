# Android internal testing — checklist

**Owner-only.** Play Console, a terminal, and about forty minutes.

## Why internal testing and not production

PLAN.md: there is no established Play account, and a new one cannot publish to production
until it has run a **closed test with at least 12 testers for 14 continuous days**. Started
on 28 July, that gate does not clear until ~11 August — after the party.

**Internal testing has none of that.** No review queue, no tester minimum, no waiting
period: the upload is installable through an opt-in link within minutes, for up to 100
testers you name. That is the Android path for 5 August, and production waits for P4.

The catch, and it is worth knowing before you print anything: a tester must **accept the
opt-in link first**, in the same Google account their phone uses. Otherwise the Play Store
link 404s for them. Party signage therefore leads with the **web** URL (PLAN.md → Sprint 7)
and treats the Android link as a bonus for people you set up in advance.

---

## 0. Before you start

| You need                   | Notes                                                          |
| -------------------------- | -------------------------------------------------------------- |
| Play Console account       | $25 one-off, and identity verification can take days. Started? |
| App created in the console | §1                                                             |
| A deployed Convex backend  | Production deployment                                          |
| `/privacy` live on the web | Required by Play's Data safety form. Same blocker as iOS.      |
| `eas` CLI logged in        | `eas whoami`                                                   |

---

## 1. Create the app

**Play Console → All apps → Create app.**

| Field            | Value                                      |
| ---------------- | ------------------------------------------ |
| App name         | `PartyBooth`                               |
| Default language | English (United Kingdom)                   |
| App or game      | App                                        |
| Free or paid     | Free (**cannot be changed to paid later**) |

Tick both declarations (Play App Signing, US export laws).

The package name comes from the first upload and must be `com.partybooth.app`, matching
`app.config.ts`. It cannot be changed afterwards, ever.

---

## 2. Build and upload

```bash
# From the repo root.
pnpm check                              # green before anything is uploaded

cd apps/mobile
eas build --profile internal --platform android
```

`internal` produces an **app bundle** (`.aab`) with `autoIncrement: true`, so the version
code bumps itself. Play refuses a version code it has already seen.

### First upload: let EAS make the keystore

`eas build` generates and stores an upload keystore on the first Android build. Say yes.
Then **back it up** — `eas credentials` → Android → download. Losing it means you can
never update this app under this package name again, and there is no recovery.

### Submit

```bash
eas submit --profile internal --platform android --latest
```

Needs a Google service account JSON with the _Release Manager_ role, exported as
`GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (see `eas.json`). If you have not set one up yet, the
alternative for the first release is faster than fixing it: **Play Console → Testing →
Internal testing → Create new release → upload the `.aab` by hand.**

---

## 3. The forms Play will not let you skip

Play blocks the release until **every** item under _Policy → App content_ is answered.
This is the part that takes the time; do it while the build runs.

### 3.1 Privacy policy

`https://<your-domain>/privacy` — the same URL the app links to from Settings. **Open it
in a browser first.**

### 3.2 Data safety

Must agree with the iOS App Privacy answers (§3.2 of `ios-submission.md`) — they describe
the same app, and a discrepancy is a policy problem on both stores.

| Question                      | Answer                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| Does your app collect data?   | Yes                                                              |
| Is it encrypted in transit?   | Yes                                                              |
| Can users request deletion?   | **Yes** — Settings → Delete account, **and** the web route below |
| Personal info → Name          | Collected, App functionality, not shared                         |
| Personal info → Email address | Collected, Account management, not shared                        |
| Photos and videos             | Collected, App functionality, not shared                         |
| App activity → Other actions  | Collected, Analytics + App functionality, not shared             |
| Crash logs / Diagnostics      | Collected, Analytics, not shared                                 |
| **Location**                  | **Not collected** — see below                                    |

Location is genuinely not collected: `blockedPermissions` in `app.config.ts` strips
`ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` from anything an autolinked library
tries to add, every photo is re-encoded before upload, and there is no video library
import. ADR 0004 §7 and ADR 0008.

"Data shared" is **No** throughout: UploadThing, Convex, Resend and Sentry are processors
acting on our instructions, which Play's definitions treat as _collection_, not _sharing_.

### 3.3 Content rating questionnaire

Category: **Social Networking / Communication**.

| Question                                | Answer                    |
| --------------------------------------- | ------------------------- |
| Violence                                | No                        |
| Sexuality                               | No                        |
| Language                                | No                        |
| Controlled substances                   | **Yes** (references only) |
| **Users can interact / share content**  | **Yes**                   |
| Users can share their location          | **No**                    |
| Shares personal info with third parties | No                        |
| Digital purchases                       | No                        |

Answering **Yes** to user interaction is what triggers the UGC follow-ups.

> **Corrected in Sprint 4's audit.** This paragraph used to claim all the follow-ups were
> satisfied while the repository contained **no terms of use and no acceptance**, which is
> two of the four. Play's UGC policy asks for accepted terms that define and prohibit
> objectionable content and behaviour — not only for the tools to deal with it afterwards.

All five now exist, and here is where each one lives:

| Follow-up                                   | Where it is                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published terms defining prohibited content | `https://<your-domain>/terms` — `apps/web/src/app/terms/page.tsx`, with the rules themselves in `@partybooth/contracts/terms` so both clients and the report sheet share one definition |
| **Accepted** terms, recorded                | Onboarding on both clients sends `TERMS_VERSION` with the name confirmation; the server records it and refuses an upload grant without it (`termsNotAccepted`)                          |
| Content moderation                          | Host approves or declines every item before the party sees it; `manual` is the default mode                                                                                             |
| In-app reporting                            | Every item that is not yours, on both clients                                                                                                                                           |
| In-app blocking                             | Long-press or the "…" menu, plus Settings → Blocked people                                                                                                                              |

Expect PEGI 12 / IARC "Teen"; the app's own 18+ gate is stricter and is stated in the
listing and in the terms.

### 3.4 Target audience and content

- Target age: **18 and over**. Nothing below 18, so the Families policy does not apply.
- Appeals to children: **No**.

### 3.5 The rest

- **Ads:** No.
- **App access:** "All functionality is restricted" → provide the demo credentials from
  `ios-submission.md` §4 and the same review notes. Internal testing has no reviewer, but
  the form is shared with production and answering it now saves doing it in August.
- **Government app:** No.
- **Financial features:** None.
- **Health:** None.
- **Data deletion URL:** `https://<your-domain>/account/deletion`.

  **This route exists** — `apps/web/src/app/account/deletion/page.tsx` — and it has to,
  because current Play policy requires a _web_ resource from which a user can request
  deletion of their account and its associated data, and Play checks that the URL you
  declare resolves. The previous version of this document declared the URL and there was
  no such route; the privacy page pointed at the in-app control and nothing else.

  What it does: explains what is removed immediately and what is erased after thirty days,
  then — for a signed-in visitor — offers the deletion control itself. The sign-in _is_ the
  identity verification, deliberately: `users.requestAccountDeletion` acts on the
  signed-in account and takes no subject, so there is no field on the page naming somebody
  else's address and therefore no way to aim it at a stranger.

  Completion is real rather than promised: `convex/deletion.ts`, run daily by
  `convex/crons.ts`, erases the account, its media and stored objects, its memberships,
  blocks and push devices, and its Better Auth credentials — including the Google grant.
  **Verify the URL loads before you submit the form.**

---

### 3.6 Permissions in the merged manifest — check them, do not assume them

The release build declares exactly three:

```
android.permission.CAMERA
android.permission.RECORD_AUDIO
android.permission.POST_NOTIFICATIONS
```

`READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` used to be declared and were **removed in
Sprint 4's audit**. They are the pair Play restricts to apps needing broad, persistent
access to a device's whole media library, and PartyBooth needs neither: library import is
a _single_ image chosen through `expo-image-picker`, which routes through the Android
system photo picker and returns one URI with no permission at all, and there is no
video-library import anywhere in the product. Declaring them bought nothing and put the
release in the path of a policy rejection with a declaration form attached.

They are now listed under `blockedPermissions` rather than merely omitted, because the
failure mode is an autolinked library adding them back. **`app.config.ts` is not the thing
to check** — the merged release manifest is:

```bash
cd apps/mobile
eas build --profile production --platform android --local   # or download the AAB
# then, from the Android SDK build-tools:
aapt2 dump permissions <path-to>.aab | sort
```

Anything beyond the three above is a finding, not a detail. `ACCESS_FINE_LOCATION`,
`ACCESS_COARSE_LOCATION`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` are blocked
for the same reason and their absence is what §3.2's "Location: not collected" rests on.

---

## 4. Store listing (minimum viable)

Internal testing does **not** require a full listing, but Play will not let you create the
release until the main store listing has its required fields.

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| App name          | `PartyBooth`                                    |
| Short description | ≤80 chars — see below                           |
| Full description  | ≤4000 chars — reuse the iOS description         |
| App icon          | 512 × 512 PNG, 32-bit, **no alpha**             |
| Feature graphic   | 1024 × 500 PNG or JPEG, no alpha                |
| Phone screenshots | 2–8, min 320 px, max 3840 px, ≤2:1 aspect ratio |
| Category          | Photography                                     |
| Contact email     | Required, and it is public                      |

Short description:

```text
Private photo and video sharing for one real party. Nothing public, ever.
```

**Icon:** `apps/mobile/assets/icon.png` is 1024², opaque, and can be downscaled to 512²
directly. (`pnpm icons` regenerates the set — see `scripts/make-icons.mjs`.)

**Feature graphic:** there is no generator for this. A flat `#FF2E88` field with the
wordmark centred in white is fine and takes two minutes; Play only requires that one
exists.

**Screenshots:** the same five as iOS §6, captured on an Android device or emulator.

---

## 5. Create the internal testing release

**Testing → Internal testing → Testers → Create email list.**

- Add every phone that needs the app on the night: yours, the co-host's, the rehearsal
  guests'.
- Each address must be the **Google account the phone is signed in with**. A personal
  address on a phone signed in with a work account will 404 on the link.

**Create new release:**

1. Choose the uploaded bundle (or upload the `.aab`).
2. Release name: `0.1.0 (1)` — Play prefills it from the version code.
3. Release notes: `First internal build for the 5 August party.`
4. **Save → Review release → Start rollout to Internal testing.**

Live within minutes. There is no review queue on this track.

**Copy the opt-in URL** — Testing → Internal testing → Testers → "Copy link". It looks
like `https://play.google.com/apps/internaltest/1234567890123456789`.

---

## 6. Verify on a real phone before you rely on it

Do this on a phone that has never had the app, and do it **before** printing signage.

- [ ] Tester opens the opt-in link and accepts. (This step is the one people skip and then
      report the link as broken.)
- [ ] Play Store page loads and shows Install.
- [ ] App installs and opens.
- [ ] Sign in works against the production backend.
- [ ] Scan the party QR → the **app** opens, not the browser. This needs
      `/.well-known/assetlinks.json` served by `apps/web` with the release SHA-256 from
      **Play Console → Setup → App signing → App signing key certificate**. That
      fingerprint is the _Play-signed_ one, which is different from the upload key — using
      the wrong one is the usual reason app links silently fall back to the browser.
- [ ] `pnpm verify:app-links https://<your-domain>` passes.
- [ ] Take a photo, hold for a video, both appear in My media.

---

## 7. Known limits on this track

- **100 testers max**, each individually listed. Beyond that needs closed testing.
- **No app links without assetlinks.json.** Android caches what it fetched at install
  time, so fix the file _before_ testers install, not after.
- **Updates need a new version code** — `autoIncrement` handles it; do not hand-edit.
- **Production is ~11 August at the earliest.** Post-launch (PLAN.md → P4). The 12-tester
  closed test can be run using the party guests themselves, which is the cheapest way to
  clear the gate.
