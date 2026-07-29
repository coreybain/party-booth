import { AUDIT_ACTIONS } from "@partybooth/contracts/analytics";
import { TERMS_VERSION } from "@partybooth/contracts/terms";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { demoLogin } from "./lib/config";
import { invalidState } from "./lib/errors";
import { mintInviteVersion } from "./lib/events";

/**
 * The App Review demo party.
 *
 * PLAN.md's App Review list ends with "a reviewer demo account that bypasses
 * live OTP (fixed-code demo login) **plus a seeded demo event**", and the second
 * half is the half that decides whether the first half is any use: a reviewer
 * who signs in successfully and lands in an empty shell cannot exercise the
 * gallery, the slideshow, reporting or blocking, and rejects the build for
 * "incomplete functionality" having done everything right.
 *
 * So this creates a whole small party in one transaction: the reviewer as owner,
 * two fictional guests, an invite version with a real code and QR token, and a
 * handful of media rows across `approved`, `pending` and `declined` so that
 * every screen has something in it and the moderation queue is not empty.
 *
 * ## Three deliberate constraints
 *
 * **It is an `internalMutation`.** There is no client path to it, so a seeder
 * cannot be called by an authenticated guest who guesses the name. The owner
 * runs it with `bun run seed:demo`, which shells out to `bunx convex run` — releases
 * are driven by the owner, never by an agent or CI (CONTRIBUTING).
 *
 * **It refuses to run unless the demo login is configured.** `demoLogin()`
 * returns a value only when `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_OTP` and an unexpired
 * `DEMO_LOGIN_EXPIRES_AT` are
 * set, which makes "is the demo account switched on?" and "does the demo party
 * exist?" the same question. A deployment that never opted in cannot end up with
 * a stray fake party in it.
 *
 * **It is idempotent.** Re-running it after a reviewer has poked at the party
 * restores nothing and duplicates nothing; it returns the existing ids. Resetting
 * a demo party is a thing you want to do at 2am the night before a resubmission,
 * and a seeder that appends a second copy each time is a seeder nobody dares run
 * twice.
 *
 * ## What it cannot do
 *
 * It cannot put bytes in storage — a Convex mutation has no network — so media
 * rows are seeded with whatever keys the caller passes in `assetKeys`. With none,
 * the rows exist and every state, count and permission is exercisable, but the
 * thumbnails render empty because `projectMedia` degrades rather than throwing.
 * That is a **known owner-action item**: upload two or three innocuous images to
 * the UploadThing app once and pass their keys. It is not something this file
 * can fix without giving an offline-verifiable mutation a network.
 */

const DEMO_EVENT_NAME = "PartyBooth demo party";

/** Fictional guests, so the reviewer sees more than one name in the grid. */
const DEMO_GUESTS = [
  { authId: "demo-guest-alex", email: "alex@demo.partybooth.invalid", displayName: "Alex" },
  { authId: "demo-guest-sam", email: "sam@demo.partybooth.invalid", displayName: "Sam" },
] as const;

/**
 * The party as it should look on the reviewer's first screen: mostly approved,
 * something waiting in the queue, and one declined item so the "hidden from
 * guests, visible to hosts and the submitter" rule has a worked example.
 */
const DEMO_MEDIA = [
  { guest: 0, state: "approved", mediaType: "photo" },
  { guest: 1, state: "approved", mediaType: "photo" },
  { guest: 0, state: "approved", mediaType: "video" },
  { guest: 1, state: "pending", mediaType: "photo" },
  { guest: 0, state: "declined", mediaType: "photo" },
] as const satisfies readonly {
  guest: number;
  state: Doc<"media">["state"];
  mediaType: Doc<"media">["mediaType"];
}[];

export const seedDemoEvent = internalMutation({
  args: {
    /**
     * UploadThing keys for objects that already exist in the demo app, in the
     * order of {@link DEMO_MEDIA}. Short lists are fine — the rest of the rows
     * simply have no thumbnail.
     */
    assetKeys: v.optional(v.array(v.string())),
    /** Injectable clock, so the seed is deterministic in tests. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    created: v.boolean(),
    eventId: v.id("events"),
    ownerUserId: v.id("users"),
    code: v.string(),
    mediaCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const demo = demoLogin();
    if (demo === undefined) {
      throw invalidState(
        "Set DEMO_LOGIN_EMAIL, DEMO_LOGIN_OTP and DEMO_LOGIN_EXPIRES_AT (a future ISO date) before seeding the App Review demo party.",
      );
    }

    const now = args.now ?? Date.now();
    const keys = args.assetKeys ?? [];

    const owner = await ensureUser(ctx, {
      authId: "demo-reviewer",
      email: demo.email,
      displayName: "App Review",
      // The reviewer has to be able to create an event to exercise the organiser
      // flow, and private beta gates that on an invitation.
      isOrganiser: true,
      now,
    });

    const existing = await ctx.db
      .query("events")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", owner))
      .collect();
    const already = existing.find((event) => event.name === DEMO_EVENT_NAME);
    if (already) {
      const invite = already.activeInviteVersionId
        ? await ctx.db.get(already.activeInviteVersionId)
        : null;
      const media = await ctx.db
        .query("media")
        .withIndex("by_event", (q) => q.eq("eventId", already._id))
        .collect();
      return {
        created: false,
        eventId: already._id,
        ownerUserId: owner,
        code: invite?.code ?? "",
        mediaCount: media.length,
      };
    }

    const eventId = await ctx.db.insert("events", {
      ownerUserId: owner,
      name: DEMO_EVENT_NAME,
      state: "live",
      // `manual`, so the reviewer's first action can be a moderation decision.
      moderationMode: "manual",
      // The demo identity is confined to events carrying this flag; see
      // `assertDemoConfinement`. Without it the published reviewer credentials
      // are usable in any real party whose code leaks.
      isDemo: true,
      storageRegion: "pdx1",
      startsAt: now,
      timeZone: "Europe/London",
      allowLibraryImport: true,
      counts: { pending: 0, approved: 0, declined: 0, total: 0 },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("memberships", {
      eventId,
      userId: owner,
      role: "owner",
      status: "active",
      joinedAt: now,
    });

    const event = await ctx.db.get(eventId);
    if (!event) throw invalidState("The demo event vanished immediately after insert.");

    const invite = await mintInviteVersion(ctx, {
      event,
      createdByUserId: owner,
      now,
    });

    const guestIds: Id<"users">[] = [];
    for (const guest of DEMO_GUESTS) {
      const userId = await ensureUser(ctx, { ...guest, isOrganiser: false, now });
      guestIds.push(userId);
      await ctx.db.insert("memberships", {
        eventId,
        userId,
        role: "guest",
        status: "active",
        inviteVersionId: invite.inviteVersionId,
        joinedAt: now,
      });
    }

    const counts = { pending: 0, approved: 0, declined: 0, total: 0 };
    for (const [index, item] of DEMO_MEDIA.entries()) {
      const uploaderUserId = guestIds[item.guest];
      if (uploaderUserId === undefined) continue;
      const storageKey = keys[index];

      await ctx.db.insert("media", {
        eventId,
        uploaderUserId,
        captureId: `demo-capture-${index + 1}`,
        state: item.state,
        mediaType: item.mediaType,
        ...(storageKey === undefined ? {} : { storageKey }),
        storageRegion: "pdx1",
        byteSize: item.mediaType === "video" ? 4_200_000 : 320_000,
        mimeType: item.mediaType === "video" ? "video/mp4" : "image/jpeg",
        checksum: `${index}`.padStart(64, "0"),
        ...(item.mediaType === "video" ? { durationSeconds: 8 } : {}),
        // The demo assets are re-encoded fixtures with no EXIF, and saying so is
        // what lets a *guest* view them — otherwise the reviewer's own gallery
        // would be empty when they signed in as anybody but the host.
        sourceMetadataStripped: true,
        fromLibrary: false,
        // The slideshow's cursor runs on approval time, so a seeded approved row
        // needs one or it sorts before every real approval for ever.
        ...(item.state === "approved"
          ? { approvedAt: now - (DEMO_MEDIA.length - index) * 60_000 }
          : {}),
        // Spread over the evening, so the slideshow's chronological order and
        // its cursor have something to be chronological about.
        capturedAt: now - (DEMO_MEDIA.length - index) * 60_000,
        uploadedAt: now - (DEMO_MEDIA.length - index) * 60_000,
        createdAt: now - (DEMO_MEDIA.length - index) * 60_000,
        updatedAt: now,
      });

      counts.total += 1;
      if (item.state === "pending" || item.state === "approved" || item.state === "declined") {
        counts[item.state] += 1;
      }
    }
    await ctx.db.patch(eventId, { counts, updatedAt: now });

    await writeAuditEvent(ctx, {
      action: AUDIT_ACTIONS.eventCreated,
      subjectType: "event",
      subjectId: eventId,
      actor: { userId: owner, role: "owner" },
      eventId,
      metadata: { demo: true, mediaCount: DEMO_MEDIA.length },
      now,
    });

    return {
      created: true,
      eventId,
      ownerUserId: owner,
      code: invite.code,
      mediaCount: DEMO_MEDIA.length,
    };
  },
});

/**
 * A `users` row, created if it is not there and marked as seeded.
 *
 * The demo accounts exist **only** in our mirror table, not in Better Auth's:
 * pre-creating rows inside the auth component from a mutation would mean
 * reaching into another system's tables. The reviewer's Better Auth user is
 * created by their first OTP sign-in, with a provider-generated id that cannot
 * be predicted here.
 *
 * That used to be "the one rough edge in the demo seed", and it was worse than
 * it looked: `onCreate` found no row for the new `authId` and inserted a
 * **second** one, so the reviewer signed into an account with no membership of
 * the party this function had just built and rejected the build for incomplete
 * functionality having done everything right.
 *
 * `seeded: true` is what closes it. The trigger in `auth.ts` adopts a *seeded*
 * row with the same normalised address — patching the real `authId` onto it —
 * and inserts only when there is none. Confining adoption to seeded rows is the
 * whole safety argument: adopting any matching address would let whoever next
 * signs up with it claim an existing account.
 */
async function ensureUser(
  ctx: Parameters<typeof writeAuditEvent>[0],
  params: {
    authId: string;
    email: string;
    displayName: string;
    isOrganiser: boolean;
    now: number;
  },
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", params.email))
    .unique();
  if (existing) return existing._id;

  return await ctx.db.insert("users", {
    authId: params.authId,
    email: params.email,
    emailVerified: true,
    displayName: params.displayName,
    onboardedAt: params.now,
    accountState: "active",
    isOrganiser: params.isOrganiser,
    isGlobalAdmin: false,
    // The reviewer has to be able to upload without first being sent through an
    // onboarding screen they have already passed.
    acceptedTermsVersion: TERMS_VERSION,
    acceptedTermsAt: params.now,
    seeded: true,
    createdAt: params.now,
    updatedAt: params.now,
  });
}
