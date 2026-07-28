# iOS submission checklist

**Owner-only.** Everything here happens in App Store Connect, Xcode or a terminal — none
of it is code, and none of it can be done by an agent. Work top to bottom; the order is
the order the dependencies actually run in.

Target: **build #1 submitted by end of Friday 1 August** (PLAN.md → Sprint 4). App Review
takes 24–48 h typically and there is no expedite worth burning on a private beta, so the
party on the 5th plans around the app **not** being approved. The guaranteed guest path
is mobile web; TestFlight external is the middle option.

> If you read one thing: §4 (demo account) is the single most common reason a social app
> is rejected on the first submission, and §7 (age rating) is the second. §7 was rewritten
> against the **current** questionnaire in Sprint 4 — the 4+/9+/13+/16+/18+ ladder with its
> capability questions, not the retired 17+ form.

---

## 0. Before you start

| You need                   | Where it comes from                                              |
| -------------------------- | ---------------------------------------------------------------- |
| Apple Developer membership | Active, paid. Check it has not lapsed — renewal is silent.       |
| App ID / bundle            | `com.partybooth.app` — must match `app.config.ts` exactly.       |
| A deployed Convex backend  | Production deployment, the one the reviewer's device will hit.   |
| A deployed web app         | For the privacy policy URL. **See §3 — this is a real blocker.** |
| `eas` CLI logged in        | `eas whoami`                                                     |

Environment for `eas submit` (not secrets, but per-owner — see `eas.json`):

```bash
export APPLE_ID="you@example.com"          # your Apple account email
export ASC_APP_ID="1234567890"             # NUMERIC id, see §1. Not the bundle id.
export APPLE_TEAM_ID="ABCDE12345"          # Membership → Team ID
export APPLE_APP_SPECIFIC_PASSWORD="..."   # appleid.apple.com → Sign-In and Security
```

---

## 1. Create the App Store Connect record

**My Apps → + → New App.**

| Field            | Value                                                            |
| ---------------- | ---------------------------------------------------------------- |
| Platforms        | iOS                                                              |
| Name             | `PartyBooth` (30 char max; must be unique across the store)      |
| Primary language | English (UK)                                                     |
| Bundle ID        | `com.partybooth.app`                                             |
| SKU              | `partybooth-ios` (internal only, never shown, cannot be changed) |
| User Access      | Full Access                                                      |

Then **App Information → General → Apple ID**: that number is `ASC_APP_ID`. Copy it now.
It is _not_ the bundle identifier, and `eas submit` will not tell you which one it wanted.

**App Information:**

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Subtitle             | `Share the party's photos, privately`                       |
| Category (primary)   | Photo & Video                                               |
| Category (secondary) | Social Networking                                           |
| Content Rights       | "Contains, shows, or accesses third-party content" → **No** |

---

## 2. Pricing and availability

- **Price:** Free.
- **Availability:** all territories is fine — the beta is invitation-only and gated in the
  app, so there is nothing to restrict geographically. English only (see §7).

---

## 3. Privacy — the blocker to clear first

### 3.1 Privacy policy URL

**Required. A dead link is an automatic rejection**, and the app links to the same URL from
Settings → Privacy policy (`apps/mobile/app/(tabs)/settings.tsx` → `PRIVACY_PATH`).

- URL: `https://<your-domain>/privacy`
- The route exists (`apps/web/src/app/privacy/page.tsx`, public and indexable). What has
  **not** been verified is that it is _deployed_ — so **open it in a browser before you
  submit**. If it 404s, the submission fails and so does the in-app button a reviewer
  will tap, and nothing in either app can notice the difference.

### 3.2 App Privacy questionnaire

**App Privacy → Get Started.** These answers describe what the app actually does. Do not
improve on them.

| Data type                       | Collected | Linked to user | Tracking | Purpose           |
| ------------------------------- | --------- | -------------- | -------- | ----------------- |
| Contact Info → Email Address    | Yes       | Yes            | No       | App Functionality |
| Contact Info → Name             | Yes       | Yes            | No       | App Functionality |
| User Content → Photos or Videos | Yes       | Yes            | No       | App Functionality |
| User Content → Other            | Yes       | Yes            | No       | App Functionality |
| Identifiers → User ID           | Yes       | Yes            | No       | App Functionality |
| Diagnostics → Crash Data        | Yes       | **No**         | No       | App Functionality |
| Diagnostics → Performance Data  | Yes       | **No**         | No       | App Functionality |

Everything else: **not collected**. In particular —

- **Location: NOT collected.** True and structurally guaranteed: the app holds no location
  permission on either platform (`blockedPermissions` on Android, no `NSLocation*` string
  on iOS), every photo is re-encoded to a fresh JPEG before upload, and video is
  camera-only with no library import. See ADR 0004 §7 and ADR 0008.
- **Tracking: No, on everything.** There is no ATT prompt because there is no tracking —
  no ad network, no data broker, no cross-app identifier.
- Crash/performance is Sentry, and it is **not** linked to identity because the scrubbing
  rules strip tokens, emails and URLs before an event leaves the device.

---

## 4. The reviewer demo account — do this properly

An App Review reviewer cannot receive a six-digit OTP email. Without a working sign-in the
app is rejected under **Guideline 2.1** with "we were unable to sign in", and that costs a
full review cycle.

### 4.1 Set the three variables on the deployment the reviewer will hit

```bash
npx convex env set DEMO_LOGIN_EMAIL      "reviewer@partybooth.app"    # any address you control
npx convex env set DEMO_LOGIN_OTP        "314159"                     # six digits
npx convex env set DEMO_LOGIN_EXPIRES_AT "2026-08-20T00:00:00Z"       # ISO date; login fails closed after this
```

All three must be set or the demo login does not exist at all (the backend returns `undefined`
and nothing changes). `DEMO_LOGIN_EXPIRES_AT` is a fail-closed kill switch: pick a date
comfortably past the expected review window — once it passes, the reviewer login stops
working even if you forget to unset the variables. This is the **production** deployment:
Apple reviews the production build against production Convex.

### 4.2 Seed the demo party

```bash
pnpm seed:demo <assetKey1> <assetKey2> <assetKey3>
```

⚠️ **Without asset keys the demo party has rows but no thumbnails.** A Convex mutation
cannot put bytes into storage, so you must first upload two or three innocuous images once
through the UploadThing app and pass their keys here. A reviewer opening an empty gallery
concludes the app does not work.

### 4.3 Put it in App Review Information

**Sign-in required: Yes.**

- Username: `reviewer@partybooth.app`
- Password: `314159`

  (The OTP field is the "password" field. Say so in the notes — a reviewer looking for a
  password field in an OTP flow will report the app as broken.)

### 4.4 Review notes — template

Copy this, fill the three `<…>`, and paste it into **App Review Information → Notes**.

```text
PartyBooth is a private, invitation-only app for sharing photos and short videos at a
single real-life party. Nothing is public: media is visible only to guests who joined
that specific party, and every URL is short-lived and permission-checked.

SIGNING IN
This app uses six-digit email codes, not passwords. For review we have provisioned a
fixed code so you do not need to receive email:

  Email: reviewer@partybooth.app
  Code:  314159        (enter this in the six-digit code field)

Sign in with Apple and Google are also offered and both work normally.

WHAT TO EXPECT AFTER SIGNING IN
The account is already a member of a seeded demo party called "<DEMO EVENT NAME>", with
a few approved photos in it, so every screen has content on first launch.

  - Camera tab: tap the shutter for a photo, or HOLD it to record a video (up to 60
    seconds, with an on-screen ring). Anything you capture is sent to the demo party
    only, and there is a 15-second Undo before it is sent.
  - Photos tab: "My media" is what you sent, with its moderation status; "Event gallery"
    is what the host has approved.
  - Settings: profile, blocked people, privacy policy, and account deletion.

REQUIRED FLOWS — WHERE TO FIND THEM
  - Report content (Guideline 1.2): Photos tab → Event gallery → the "..." button in the
    corner of any tile that is not yours, or long-press the tile → "Report to the host".
    Pick a reason and send. Reports flag the item for the party's host to review; they
    deliberately do not auto-hide content, because that would let any guest veto any
    other guest's photo.
  - Block a user (Guideline 1.2): the same menu → "Block <name>", or the offer shown
    immediately after sending a report. Blocking hides everything that person posts, for
    you only, everywhere in the app. Blocked accounts are listed and can be unblocked in
    Settings → Blocked people.
  - Account deletion (5.1.1(v)): Settings → Delete account → confirm. Access is revoked
    immediately and the account is signed out. Data is purged after 30 days, during which
    it can be restored on request. Photos already sent to a party are retained but the
    uploader's name is removed from them — this is explained in the confirmation screen
    before the guest commits.

MODERATION
The party host approves or declines every submission before it appears in the shared
gallery (this is the default "manual" mode). Hosts also see reported items flagged.

AGE RATING
The app is 18+ and invitation-only, with published terms at `/terms` that say so and a
recorded acceptance at onboarding. It is not directed at children.

CONTACT
<YOUR NAME>, <YOUR EMAIL> — happy to answer anything or jump on a call.
```

### 4.5 After approval

```bash
npx convex env remove DEMO_LOGIN_EMAIL
npx convex env remove DEMO_LOGIN_OTP
npx convex env remove DEMO_LOGIN_EXPIRES_AT
```

**Do not skip this.** A fixed-code login left on a production deployment is a permanent
credential in a public document.

---

## 5. Export compliance

**One answer, and `app.config.ts` already declares it.**

`ITSAppUsesNonExemptEncryption: false` is set in the Info.plist, so App Store Connect
should not ask. If it does:

- "Does your app use encryption?" → **Yes** (HTTPS counts).
- "Does it qualify for an exemption?" → **Yes**, "only uses encryption exempt under
  category 5 part 2 / uses standard encryption provided by the operating system".

That is the truthful answer: the only cryptography is HTTPS (OS-provided) and SHA-256
checksums for uploads, which is hashing rather than encryption. No CCATS filing, no
year-end self-classification report.

---

## 6. Screenshots

Required for **6.9" iPhone** only — Apple scales that set down for every smaller size, and
one set is all a private beta needs.

| Display size    | Pixels (portrait) | Device to capture on           | Count |
| --------------- | ----------------- | ------------------------------ | ----- |
| 6.9" iPhone     | 1320 × 2868       | iPhone 16 Pro Max / 17 Pro Max | 3–6   |
| 6.5" (optional) | 1242 × 2688       | iPhone 11 Pro Max              | 3–6   |

iPad is **not** required — `supportsTablet: false`.

Capture these five, in this order (the order tells the story a reviewer reads):

1. **Camera tab**, viewfinder live, shutter visible with the "Tap for a photo. Hold to
   record video" hint. This is the app in one image.
2. **The undo pill** mid-countdown, over the viewfinder.
3. **Photos → Event gallery**, a filled grid with at least one video tile showing its
   poster and duration badge.
4. **Photos → My media**, showing a couple of different moderation statuses.
5. **Settings**, scrolled so that Privacy policy, Blocked people and Delete account are
   all visible in one frame. This one is for the reviewer, not for the store.

Rules that get screenshots rejected: no device frames or bezels, no marketing text
overlaid promising features that are not there, no placeholder/lorem content, no other
company's trademarks visible in the photos you seed.

**Promotional text** (170 chars, editable without a new build — use it for party dates):

```text
Private photo and video sharing for one real party. Scan the QR, capture the night, and the host approves what makes the gallery. Nothing is public.
```

**Description** — draft:

```text
PartyBooth is a shared camera roll for a single party, and nothing more.

Scan the host's QR code or type the six-digit code to join. Take photos, hold the shutter
to record a short video, and everything you capture goes to that party — and only that
party. The host approves what appears in the shared gallery, so the night stays the
night.

• Private by default. No public links, no profiles, no follower counts.
• Photos and videos are stored privately and served over short-lived, permission-checked
  links.
• Location data is removed from everything you send.
• Take back anything you have sent, permanently, at any time.
• Report anything you shouldn't be seeing, and block anyone you'd rather not.

PartyBooth is invitation-only while it is in beta, and it is for adults.
```

**Keywords** (100 chars, comma-separated, no spaces after commas):

```text
party,photos,camera,event,wedding,shared,album,gallery,guests,private,video,qr
```

**Support URL:** `https://<your-domain>/support` (or a mailto page — but it must resolve).

---

## 7. Age rating questionnaire

**App Information → Age Rating → Edit.**

> **Rewritten in Sprint 4's audit.** The table that used to be here answered the _old_
> questionnaire — the one whose top rung was 17+ — and claimed an 18+ restriction the app
> did not enforce. Apple's current questionnaire uses **4+ / 9+ / 13+ / 16+ / 18+**, asks
> its content questions on a three-point frequency scale, and adds capability questions
> that did not exist. Answering the old form from memory is how a submission comes back
> with "the age rating does not reflect the app".

### 7.1 Frequency questions

Each is **None**, **Infrequent or Mild**, or **Frequent or Intense**.

| Question                                              | Answer                 |
| ----------------------------------------------------- | ---------------------- |
| Cartoon or Fantasy Violence                           | None                   |
| Realistic Violence                                    | None                   |
| Prolonged Graphic or Sadistic Realistic Violence      | None                   |
| Profanity or Crude Humor                              | **Infrequent or Mild** |
| Mature/Suggestive Themes                              | None                   |
| Horror/Fear Themes                                    | None                   |
| Medical/Treatment Information                         | None                   |
| Alcohol, Tobacco, or Drug Use or References           | **Infrequent or Mild** |
| Simulated Gambling                                    | None                   |
| Sexual Content or Nudity                              | None                   |
| Graphic Sexual Content and Nudity                     | None                   |
| Violent Themes (sexual violence, kidnapping, torture) | None                   |

Alcohol is **Infrequent or Mild** and not None because this is a party app and the photos
will contain drinks. Profanity is the same answer for the same reason — guests type names
and report details, and a party's captions are not sanitised. Answering None on a party
app is the kind of small dishonesty that gets the whole questionnaire re-examined.

### 7.2 Capability questions

These are yes/no and they are what actually move the rating.

| Question                                                    | Answer  |
| ----------------------------------------------------------- | ------- |
| Does your app contain **user-generated content**?           | **Yes** |
| Does your app have **in-app controls to restrict** UGC?     | **Yes** |
| Does your app include **messaging or chat** between users?  | No      |
| Does your app include **unrestricted web access**?          | No      |
| Does your app include **gambling**?                         | No      |
| Does your app include **contests**?                         | No      |
| Is your app **made for kids**?                              | No      |
| Does your app contain **medical or treatment information**? | No      |

**Saying yes to UGC is not optional and not a negotiation.** The follow-ups ask what you
do about it, and all four answers exist and are named in §4.4: host moderation before
anything is shown to the party, in-app reporting on every item, in-app blocking, and a
published contact. This is also the question the whole of Sprint 4's App Review work was
for.

**"In-app controls to restrict UGC" is Yes** because a host approves or declines every
item before a guest sees it (`manual` mode is the default), guests can block, and guests
can withdraw their own submissions.

### 7.3 The 18+ question, and what has to be true before you answer it

Apple offers an override that pins the app to 18+ regardless of the content answers. It
is legitimate **only when the app actually restricts itself to adults**, and reviewers do
check: an override with no gate behind it is a rejection, and it is the specific thing the
previous version of this document claimed without implementing.

What now exists, and is what you are attesting to:

- **Terms of use** at `https://<your-domain>/terms`, which state the beta is 18+ and set
  out what may not be posted. They are the document Apple's guideline 1.2 and Play's UGC
  policy both ask for.
- **Recorded acceptance.** Onboarding sends `TERMS_VERSION` with the name confirmation and
  the server records it; an account with no accepted version is refused an upload grant
  (`termsNotAccepted`). The acceptance is versioned, so changing the rules asks everybody
  again.
- **The footer on every screen** says "Private beta · 18+", including the sign-in screen a
  reviewer sees first.

Answer **"Is your app restricted to users 18 years or older?" → Yes**, and in the review
notes point at `/terms` and at the acceptance step. Attach the terms URL in the **License
Agreement** field if you want the strongest version of the claim — Apple's standard EULA
does not carry an age restriction, so a custom EULA is what turns "we say 18+" into a
contract term. Not doing that is defensible; claiming the restriction with _neither_ the
terms nor the acceptance was not.

If you would rather not defend the override at all, remove it: with the answers in §7.1
the app rates **16+** on content plus UGC, which is a perfectly shippable rating for a
private beta and is one fewer thing to argue about. Do **not** leave the override set and
the restriction unimplemented — that is the state this section used to describe.

---

## 8. Build, submit, ship

```bash
# From the repo root.
pnpm check                              # typecheck + lint + tests must be green first

cd apps/mobile
eas build --profile production --platform ios
# ~20–40 min. Watch it: a failure here at 17:00 on the 1st is the whole deadline.

eas submit --profile production --platform ios --latest
```

Then in App Store Connect:

1. **Distribution → iOS App → + Build** — pick the build that just landed. It takes
   5–15 min to finish processing before it appears; "Processing" is not an error.
2. Confirm **Export Compliance** shows as answered (it should, from §5).
3. Fill **Version Release**: choose **Manually release this version**. You want to decide
   when it goes live, not have it appear mid-party.
4. **Add for Review → Submit**.

Status should read **Waiting for Review** — that is RC4's iOS half.

### If it is rejected

Read the actual guideline number in Resolution Center; the summary line is usually less
specific than the detail. The three likely ones, in order of likelihood:

- **2.1 — could not sign in.** Re-check §4: are both env vars set on the _production_
  deployment, and did the seed run _with_ asset keys? Reply in Resolution Center with a
  screen recording of the demo login working; that usually resolves it without a new
  build.
- **1.2 — UGC safeguards.** Reply pointing at the exact paths in §4.4. All four
  safeguards exist; this is a "they could not find it" rejection, not a "it is missing"
  one, and it is answered with words rather than code.
- **5.1.1(v) — account deletion.** Same: Settings → Delete account. Say that access is
  revoked immediately and the 30-day window is restoration, not a delay before deletion
  starts.

Fix, reply, and resubmit the same day (Sprint 6 reserves time for exactly this).

---

## 9. Post-submission

- [ ] TestFlight: add yourself and 2–3 rehearsal guests as internal testers. Internal
      TestFlight needs **no** beta review and installs in minutes — this is the real
      fallback if App Review misses the 5th.
- [ ] **Unset `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_OTP` and `DEMO_LOGIN_EXPIRES_AT` once the build is approved** (§4.5) — expiry fails closed either way.
- [ ] Do not print App Store links on the party signage until the app is actually
      approved. The web URL is primary (PLAN.md → Sprint 7).
