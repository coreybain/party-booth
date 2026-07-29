# Product spec

> Seeded from [`PLAN.md`](../PLAN.md) on 28 Jul 2026. `PLAN.md` remains authoritative for scope and
> sequencing; this document is the durable description of the product.

## In one paragraph

PartyBooth turns a party into a shared camera roll without handing anyone a shared account. The
organiser creates an event and prints a QR code. Guests scan it, sign in, and capture photos and
short videos on their own phone. The organiser (and any co-hosts) approve or decline each
submission, and approved media appears live on a fullscreen slideshow. Everything is private:
storage ACLs are private, every read is a permission-checked short-lived URL, and there are no
public media links anywhere.

## The constraint that shapes everything

A real party with 10–50 guests happens on **Tuesday 5 August 2026**. Scope is cut against that date.

The **guaranteed guest path is mobile web**. The iOS and Android apps are built and submitted as if
they will make it, but the party must not depend on App Review. Signage leads with the web URL;
store links appear only if approved in time.

## Audience and boundaries

Private beta: **invitation-only, global English, 18+**. No billing, no quotas, no public media URLs,
no facial recognition, no admin impersonation. Marketing, paid plans, child accounts and custom
domains are out of scope.

## Roles

| Role          | Gets in via                                        | Can                                                                                                                                           |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalAdmin` | separate `/admin` OTP login, server-side allowlist | operate the platform: invite organisers, lock accounts, rotate codes, audit                                                                   |
| `owner`       | creates the event                                  | everything within their own event, including deletion and transfer                                                                            |
| `cohost`      | invited by the owner, by email                     | run the party: moderate, edit settings, pause/resume, present, rotate invites — never delete, archive, transfer, or change who else is a host |
| `guest`       | joins with a QR token or six-digit code            | capture, upload, see own media and its status, withdraw, view the gallery                                                                     |

Global admins have **no media access and no impersonation**, by design. See
[`domain-model.md`](domain-model.md) for the precise permission matrix.

## Identity

- **Organisers, web:** six-digit email OTP — 10-minute expiry, five attempts, 60-second resend cooldown.
- **Guests, web:** Google sign-in _or_ email OTP. There is no Sign in with Apple on the web.
- **Guests, app:** Sign in with Apple or Google, then a name + photo confirmation step. A verified
  email that matches an organiser or co-host record unlocks the host surfaces in the app. Apple
  private-relay users can verify a real organiser email by OTP.
- **Global admins:** `/admin` OTP against a server-side allowlist, kept separate from the organiser shell.

Rate limiting and enumeration protection apply to both join and OTP.

## Surfaces

### Organiser website — launch scope

OTP login. Event creation (name, schedule and timezone, cover image, accent colour, moderation
mode). Six-digit code plus QR, invite versions and rotation with a keep-or-revoke choice for
existing memberships. A live home showing code/QR, status, pending count, recent submissions and
totals. Moderation: masonry grid, approve/decline, filters by status, type and submitter, bulk
select. Slideshow: fullscreen, live-updating, photos plus muted autoplay video, pause and skip,
chronological or shuffled. Settings limited to essentials — schedule, moderation mode, co-host
invite, rotation.

Keyboard-driven review and submitter grouping ship only if time allows.

**Who may open the console.** An organiser invitation, membership of the admin allowlist, **or
hosting at least one event**. The third is the co-host's way in and it is not the same as being an
organiser: accepting a co-host invitation grants a membership and deliberately does not set
`isOrganiser`, because that flag gates _creating_ events and the beta is invitation-only. So a
co-host reaches the moderation queue, the slideshow and the event's settings, and the "New event"
control is not offered to them.

**An account that is locked or scheduled for deletion** gets its own screen rather than the
sign-in page or a permission error — it is the one audience entitled to know exactly what has
happened to it, and account deletion stays reachable from there (Apple 5.1.1(v)). Guests of a
frozen party are told something deliberately vaguer; see the lock section below.

### Guest mobile web — the guaranteed path

QR → HTTPS universal link → join with token or code → Google/OTP sign-in → name confirmation.
Capture or select a photo or video (`input capture` / `getUserMedia`), upload with progress, see
your own submissions and their moderation status, withdraw a submission. Approved event gallery.

### Expo app (iOS 17+, Android 10+)

Tabs: Camera, Photos (My media / Event gallery), Settings, plus a conditional Host tab. Clean camera
only at launch — tap for photo, hold for video, flash, flip, both orientations. **No effects.**
Auto-send with a 15-second undo, backed by a durable local queue that resumes in the foreground;
background retry is best-effort and post-launch. The Host tab carries QR/code, rotation, the pending
queue and quick approve/decline. Expo push covers upload failure and recovery, event open and close,
and a pending-queue threshold ping for hosts — the last of these on a **per-user threshold**
(default 5) and debounced, so thirty photos arriving in one minute buzz a host once rather than
thirty times. Every category can be switched off individually in Settings.

The Host tab also carries the party's own controls: open early, pause new photos, resume, push the
finish time out by an hour, and end the party. Ending it is **owner-only** and asks first; a co-host
may do everything else, which is what makes a co-host a working pressure valve when the owner is on
the dance floor. Rotation asks the keep-or-revoke question explicitly in a modal and says what the
revoke path costs — every guest re-joins, and nobody is banned.

The notification permission prompt is deliberately **not** shown at launch. iOS grants one system
prompt per install, so the app spends it after the guest's **first successful join**, when they have
a reason to say yes; Settings offers a way back for somebody who declined. A tapped notification
switches to the party it names and then opens the screen that answers it — upload trouble to My
media, a party opening to the Camera, a host's queue to the Host tab.

**App Review requirements, all mandatory for submission:** in-app content reporting, user blocking,
in-app account deletion, a privacy policy URL, a 17+/18+ age rating, Sign in with Apple alongside
Google, and a reviewer demo account that bypasses live OTP via a fixed demo code, plus a seeded demo
event.

### Admin console

A distinct `/admin` shell — not a tab inside the organiser app. Invite organisers; inspect accounts,
events, asset counts and storage; lock and unlock; schedule and restore deletion; rotate codes
(random, or a specific collision-checked value); revoke memberships. Every action requires a
confirmation and a reason, and writes an immutable audit event.

**Agreed cut order if the schedule bites:** specific-value code rotation → job-health dashboards →
the deletion-scheduling UI (a script is the fallback). Organiser invite, lock/unlock and audit are
the non-negotiable core. _Nothing was cut — the full backend surface shipped in Sprint 5, including
specific-value rotation and job health._

Job health covers what is supposed to happen by itself and has not: media tombstoned whose objects
are still in storage, deletion jobs past their date, and the push queue. **Pending exports reads a
constant zero** — ZIP exports are P2 and there is no job table to count, and an honest zero is
better than an invented number.

**Locking an organiser freezes every event they own**, for everybody: co-host access, joining,
upload grants, the slideshow, and the issuance of signed URLs. That is the point of the control, and
it is derived from the event's owner rather than swept over a list, so an event created a moment
before the lock is covered too.

The two audiences are told different things, and that split is deliberate. The **locked account**
is told plainly that it is suspended, what it means for the parties it runs, and how to appeal. A
**guest** of one of those parties is told only that the party is unavailable — a suspension is a
fact about a third party's standing with us, and thirty people in a room are not entitled to it. The
guest-facing screens also drop the usual "ask the host for the current QR" advice in this case: a
new code would change nothing, and the suggestion points the room at a host who cannot fix it.

## Media rules

Photos ≤ 20 MB. Videos ≤ 60 s and ≤ 250 MB. Private ACLs everywhere. Reads go through
permission-checked short-lived URLs. Location metadata is stripped from served derivatives.
Pre-effect frames are never retained — moot at launch, since there are no effects.

Moderation modes at launch are `manual` and `automatic`. The `ai` mode is post-launch.

## Platform

Turborepo + Bun, strict TypeScript, validated environment, shared schemas/permissions/types.
Convex in **US East (N. Virginia)** with Better Auth on Convex; Convex subscriptions drive the
dashboards, galleries and slideshow. UploadThing on a paid plan in region **pdx1** with default ACL
**Private**; the route handlers live in `apps/web`. Clients request a short-lived one-time upload
grant from Convex (`eventId`, `captureId`, `mediaType`, `byteSize`, checksum, `storageRegion`) and
middleware validates it before an upload URL is issued; completion callbacks are idempotent. Resend
sends OTP and invite mail. Sentry collects errors with scrubbing.

See [ADR 0001](adr/0001-monorepo-runtime.md) and [ADR 0002](adr/0002-storage-region-adapter.md).

## Explicitly deferred to post-launch

AI moderation (`omni-moderation-latest`), ZIP exports via Trigger.dev, the 30-day purge automation,
Banuba and camera effects, PostHog dashboards, and load testing at 250 guests. Post-launch is
re-cut into P1–P5 in [`PLAN.md`](../PLAN.md#post-launch-milestones-former-m2m5-re-cut).

Note the asymmetry: the **deletion lifecycle states ship at launch** even though the purge job does
not. Guests and organisers can request deletion in-app — Apple requires it — and the account moves
to `deletionScheduled` immediately and loses access. Only the eventual hard purge is deferred.

## How we know it works

The test bar is deliberately focused, not comprehensive:

- Unit tests on permissions, state transitions and grant validation.
- One Playwright happy path: OTP login → create event → guest joins → upload → moderate → slideshow.
- A manual pass on two physical phones, one iOS and one Android, covering both app and web paths.
- Signed-URL and grant-expiry spot checks.
- A **dress-rehearsal party on ~3 Aug** with about five real people, real phones, home Wi-Fi and one
  phone deliberately on cellular.

Each sprint ends in a releasable checkpoint (RC1–RC7) defined in [`TODO.md`](../TODO.md) — something
deployed that can be opened on a real phone that evening.

## Known risks we are carrying

1. **App Review misses 5 Aug** — likely enough to plan around. The web path is fully sufficient;
   TestFlight external review is the middle option.
2. **Play production is impossible by 5 Aug** — the new-account 14-day closed-testing rule. Accepted:
   Android guests get an internal-testing link, everyone else uses the web.
3. **The full admin console competes with party-critical work** — accepted knowingly, with the cut
   order above.
4. **Solo moderation during the party** — mitigated by co-hosts and by `automatic` mode as a pressure
   valve. AI assist is post-launch.
5. **Convex ↔ storage cross-country hop** (US East ↔ pdx1, ~60 ms) — accepted; it affects
   server-side preview processing latency only.
6. **OTP deliverability on party night** — the Resend domain is warmed from D1, Google sign-in is the
   primary web path and OTP is the fallback.
