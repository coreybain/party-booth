import { TERMS_VERSION, type RandomBytes } from "@partybooth/contracts";
import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { convexTest, type TestConvex } from "convex-test";
import {
  anyApi,
  type ApiFromModules,
  type FilterApi,
  type FunctionReference,
  type FunctionType,
  type SchemaDefinition,
} from "convex/server";

import type { Doc, Id } from "./_generated/dataModel";
import { setPushAdapterOverride } from "./lib/push";
import { createFakePushAdapter, type FakePushAdapter, type FakePushOptions } from "./lib/push/fake";
import { setStorageAdapterOverride } from "./lib/storage";
import {
  createFakeStorageAdapter,
  type FakeStorageAdapter,
  type FakeStorageOptions,
} from "./lib/storage/fake";
import type * as admin from "./admin";
import type * as avatars from "./avatars";
import type * as blocks from "./blocks";
import type * as cohosts from "./cohosts";
import type * as deletion from "./deletion";
import type * as demo from "./demo";
import type * as emails from "./emails";
import type * as events from "./events";
import type * as invites from "./invites";
import type * as join from "./join";
import type * as media from "./media";
import type * as moderation from "./moderation";
import type * as otp from "./otp";
import type * as push from "./push";
import schema from "./schema";
import type * as slideshow from "./slideshow";
import type * as stats from "./stats";
import type * as users from "./users";

/**
 * Shared fixtures for the convex-test suites.
 *
 * Two dots in the filename on purpose: the Convex bundler skips those when it
 * scans for function entry points, so this sits next to the code it seeds
 * without being deployed — the same trick `*.test.ts` and `auth.config.ts` use.
 * Vitest does not pick it up as a suite either, since it does not end `.test.ts`.
 */

export type T = TestConvex<SchemaDefinition<typeof schema.tables, true>>;

/**
 * convex-test finds function modules by looking for a `_generated` directory.
 * Bun's hoisted node_modules defeats its "sibling to node_modules" heuristic,
 * so every suite passes the module map explicitly. `import.meta.glob` is
 * resolved relative to *this* file, which is why it lives at the root of
 * `convex/` alongside the suites.
 */
export const modules = import.meta.glob("./**/*.*s");

export function makeTest(): T {
  return convexTest(schema, modules);
}

/* -------------------------------------------------------------------------- */
/* A typed `api`, until codegen can produce one                                */
/* -------------------------------------------------------------------------- */

/**
 * `_generated/api.d.ts` is the **generic** fallback (`AnyApi`) because
 * `convex codegen` cannot reach a deployment — see the package README. Indexing
 * it gives `AnyModuleDirOrFunc | undefined`, which `t.mutation` will not accept,
 * so every existing suite has had to hand-cast each function reference it calls.
 *
 * This builds the precise api from the modules instead, exactly the way real
 * codegen does (`ApiFromModules` → `FilterApi`). Two consequences worth having:
 * argument and return types in the tests come from the handlers themselves
 * rather than from a hand-written table that can drift, and calling a function
 * that does not exist is a compile error.
 *
 * **Delete this block** once `bunx convex dev` has run against a real project:
 * `_generated/api.d.ts` will then say the same thing, and the tests can import
 * from there like production code does.
 */
type FullApi = ApiFromModules<{
  admin: typeof admin;
  avatars: typeof avatars;
  blocks: typeof blocks;
  cohosts: typeof cohosts;
  deletion: typeof deletion;
  demo: typeof demo;
  emails: typeof emails;
  events: typeof events;
  invites: typeof invites;
  join: typeof join;
  media: typeof media;
  moderation: typeof moderation;
  otp: typeof otp;
  push: typeof push;
  slideshow: typeof slideshow;
  stats: typeof stats;
  users: typeof users;
}>;

export const api = anyApi as unknown as FilterApi<
  FullApi,
  FunctionReference<FunctionType, "public">
>;

export const internal = anyApi as unknown as FilterApi<
  FullApi,
  FunctionReference<FunctionType, "internal">
>;

export const ADMIN_EMAIL = "admin@partybooth.test";

/**
 * The admin allowlist comes from the environment, and `@partybooth/env`
 * memoises each variable the first time it is read — so the cache has to be
 * dropped alongside the value.
 */
export function setAllowlist(value: string | undefined): void {
  if (value === undefined) {
    delete process.env["ADMIN_EMAIL_ALLOWLIST"];
  } else {
    process.env["ADMIN_EMAIL_ALLOWLIST"] = value;
  }
  resetEnvCache(serverEnv);
}

/* -------------------------------------------------------------------------- */
/* Seeds                                                                      */
/* -------------------------------------------------------------------------- */

export interface SeedUserOptions {
  authId: string;
  email: string;
  emailVerified?: boolean;
  displayName?: string;
  accountState?: Doc<"users">["accountState"];
  isOrganiser?: boolean;
  isGlobalAdmin?: boolean;
  isPrivateRelayEmail?: boolean;
  /** `null` seeds an account that has **not** accepted the terms. */
  acceptedTermsVersion?: string | null;
}

export async function seedUser(t: T, over: SeedUserOptions): Promise<Id<"users">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: over.authId,
      email: over.email,
      emailVerified: over.emailVerified ?? true,
      displayName: over.displayName ?? "Test User",
      accountState: over.accountState ?? "active",
      // Every event-creating fixture is an invited organiser unless it is
      // testing the gate itself.
      isOrganiser: over.isOrganiser ?? true,
      isGlobalAdmin: over.isGlobalAdmin ?? false,
      ...(over.isPrivateRelayEmail === undefined
        ? {}
        : { isPrivateRelayEmail: over.isPrivateRelayEmail }),
      // Accepted by default, because onboarding takes it and a fixture that has
      // not onboarded is not the thing most suites are about. The suite that
      // *is* about the gate passes `acceptedTermsVersion: undefined`.
      ...(over.acceptedTermsVersion === null
        ? {}
        : {
            acceptedTermsVersion: over.acceptedTermsVersion ?? TERMS_VERSION,
            acceptedTermsAt: now,
          }),
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export interface SeedEventOptions {
  name?: string;
  state?: Doc<"events">["state"];
  moderationMode?: Doc<"events">["moderationMode"];
  startsAt?: number;
  endsAt?: number;
  uploadStartsAt?: number;
  allowLibraryImport?: boolean;
  publicGalleryEnabled?: boolean;
}

/**
 * An event with an owner membership, as `events.create` would leave it — but
 * with no invite version, so a suite can mint one deliberately.
 */
export async function seedEvent(
  t: T,
  ownerUserId: Id<"users">,
  over: SeedEventOptions = {},
): Promise<Id<"events">> {
  const now = Date.now();
  const eventId = await t.run(async (ctx) =>
    ctx.db.insert("events", {
      ownerUserId,
      name: over.name ?? "Test party",
      state: over.state ?? "live",
      moderationMode: over.moderationMode ?? "manual",
      storageRegion: "pdx1",
      startsAt: over.startsAt ?? now,
      ...(over.endsAt === undefined ? {} : { endsAt: over.endsAt }),
      ...(over.uploadStartsAt === undefined ? {} : { uploadStartsAt: over.uploadStartsAt }),
      timeZone: "Europe/London",
      allowLibraryImport: over.allowLibraryImport ?? true,
      ...(over.publicGalleryEnabled === undefined
        ? {}
        : { publicGalleryEnabled: over.publicGalleryEnabled }),
      counts: { pending: 0, approved: 0, declined: 0, total: 0 },
      createdAt: now,
      updatedAt: now,
    }),
  );
  await seedMembership(t, eventId, ownerUserId, "owner");
  return eventId;
}

export async function seedMembership(
  t: T,
  eventId: Id<"events">,
  userId: Id<"users">,
  role: Doc<"memberships">["role"],
  status: Doc<"memberships">["status"] = "active",
): Promise<Id<"memberships">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("memberships", { eventId, userId, role, status, joinedAt: Date.now() }),
  );
}

export interface SeedInviteOptions {
  code?: string;
  token?: string;
  status?: Doc<"inviteVersions">["status"];
  version?: number;
  makeActive?: boolean;
}

export async function seedInviteVersion(
  t: T,
  eventId: Id<"events">,
  createdByUserId: Id<"users">,
  over: SeedInviteOptions = {},
): Promise<{ inviteVersionId: Id<"inviteVersions">; code: string; token: string }> {
  const code = over.code ?? "482913";
  const token = over.token ?? "ABCDEFGHJKMNPQRSTVWXYZ0123456789".slice(0, 32);
  const status = over.status ?? "active";

  const inviteVersionId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("inviteVersions", {
      eventId,
      version: over.version ?? 1,
      code,
      token,
      status,
      createdByUserId,
      createdAt: Date.now(),
    });
    if ((over.makeActive ?? status === "active") === true) {
      await ctx.db.patch(eventId, { activeInviteVersionId: id });
    }
    return id;
  });

  return { inviteVersionId, code, token };
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Point the storage seam at an in-memory fake for the duration of a test.
 *
 * Returns the fake so the suite can assert the two facts only the provider
 * knows: whether a file still exists, and what was asked to be deleted. Always
 * pair it with `useFakeStorage(undefined)` — or the `afterEach` below — because
 * convex-test shares the module registry across a file.
 */
/**
 * The fake currently installed, if any.
 *
 * Kept so {@link seedMedia} can tell it about the object it just claimed exists.
 * A seeded row whose key is *not* in the fake makes `deleteFiles` report a short
 * count, which the purge path now — correctly — treats as an unfinished delete;
 * without this every seeded withdrawal would exercise the failure branch.
 */
let installedFake: FakeStorageAdapter | undefined;

export function useFakeStorage(options: FakeStorageOptions = {}): FakeStorageAdapter {
  const adapter = createFakeStorageAdapter(options);
  setStorageAdapterOverride(() => adapter);
  installedFake = adapter;
  return adapter;
}

export function clearFakeStorage(): void {
  setStorageAdapterOverride(undefined);
  installedFake = undefined;
}

/**
 * Run everything `ctx.scheduler.runAfter(0, …)` queued, and wait for it.
 *
 * convex-test implements the scheduler with a real `setTimeout`, so a job
 * queued by the mutation you just awaited is still `pending` when the next line
 * of the test runs — `finishInProgressScheduledFunctions()` on its own waits
 * only for jobs whose timer has already fired, which is none of them. Yielding
 * to the macrotask queue first is what lets the timer fire; the loop covers a
 * job that schedules another job.
 *
 * Without this, a withdrawal's file delete executes *after* the test has
 * finished and `afterEach` has torn the fake adapter down, and the failure it
 * produces looks like a bug in the storage seam rather than a race in the
 * harness.
 */
export async function runScheduled(t: T, rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/**
 * The shared secret `media.completeUpload` demands. Set it around any test that
 * exercises the provider callback, and clear it again — an unset secret is the
 * production default and other suites depend on that.
 */
export const CALLBACK_SECRET = "test-callback-secret-that-is-long-enough-000";

export function setCallbackSecret(value: string | undefined): void {
  if (value === undefined) {
    delete process.env["UPLOAD_CALLBACK_SECRET"];
  } else {
    process.env["UPLOAD_CALLBACK_SECRET"] = value;
  }
  resetEnvCache(serverEnv);
}

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

export interface SeedMediaOptions {
  state?: Doc<"media">["state"];
  captureId?: string;
  mediaType?: Doc<"media">["mediaType"];
  storageKey?: string;
  /** A derivative, as a completed preview upload would have left it. */
  previewKey?: string;
  posterKey?: string;
  byteSize?: number;
  previewByteSize?: number;
  posterByteSize?: number;
  fromLibrary?: boolean;
  /**
   * Left **absent** unless a suite says otherwise, which is what a Sprint-3 row
   * looks like and what the `mayServeOriginal` suite depends on.
   */
  sourceMetadataStripped?: boolean;
  createdAt?: number;
}

/**
 * A media row as `completeUpload` would have left it, without going through the
 * grant machinery — for the read-path and withdrawal suites, which are about
 * what happens *after* an upload rather than about how it got there.
 *
 * Counters are updated the way the real path does, so a suite that seeds three
 * pending items and then withdraws one can still assert the badge.
 */
export async function seedMedia(
  t: T,
  eventId: Id<"events">,
  uploaderUserId: Id<"users">,
  over: SeedMediaOptions = {},
): Promise<Id<"media">> {
  const now = over.createdAt ?? Date.now();
  const state = over.state ?? "pending";
  const storageKey = over.storageKey ?? `key_${Math.random().toString(36).slice(2, 10)}`;

  // A row that names an object and a provider that has never heard of it is not
  // a state the product can reach, so the fake is told about it too.
  if (state !== "processing" || over.storageKey !== undefined) {
    installedFake?.put(storageKey, over.byteSize ?? 1024);
  }
  if (over.previewKey !== undefined)
    installedFake?.put(over.previewKey, over.previewByteSize ?? 64);
  if (over.posterKey !== undefined) installedFake?.put(over.posterKey, over.posterByteSize ?? 64);

  return await t.run(async (ctx) => {
    const mediaId = await ctx.db.insert("media", {
      eventId,
      uploaderUserId,
      captureId: over.captureId ?? `capture-${Math.random().toString(36).slice(2, 12)}`,
      state,
      mediaType: over.mediaType ?? "photo",
      ...(state === "processing" && over.storageKey === undefined ? {} : { storageKey }),
      ...(over.previewKey === undefined ? {} : { previewKey: over.previewKey }),
      ...(over.previewByteSize === undefined ? {} : { previewByteSize: over.previewByteSize }),
      ...(over.posterKey === undefined ? {} : { posterKey: over.posterKey }),
      ...(over.posterByteSize === undefined ? {} : { posterByteSize: over.posterByteSize }),
      storageRegion: "pdx1",
      byteSize: over.byteSize ?? 1024,
      mimeType: "image/jpeg",
      checksum: "a".repeat(64),
      fromLibrary: over.fromLibrary ?? false,
      ...(over.sourceMetadataStripped === undefined
        ? {}
        : { sourceMetadataStripped: over.sourceMetadataStripped }),
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const event = await ctx.db.get(eventId);
    if (event) {
      const counts = { ...event.counts };
      if (state === "pending" || state === "approved" || state === "declined") counts[state] += 1;
      if (state !== "deleted") counts.total += 1;
      await ctx.db.patch(eventId, { counts });
    }
    return mediaId;
  });
}

/**
 * The App Review demo login, on and off.
 *
 * All **three** variables together or none: that grouping *is* the gate, so a
 * helper that could set some without the others would let a suite assert a state
 * the product cannot be in. `DEMO_LOGIN_EXPIRES_AT` joined the pair in Sprint 4
 * so the bypass switches itself off on a date rather than when somebody
 * remembers to unset it.
 */
export const DEMO_EMAIL = "review@partybooth.test";
export const DEMO_OTP = "424242";
/** Far enough out that no suite has to think about the clock. */
export const DEMO_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
/** In the past, for the suite that pins "an expired window is a closed door". */
export const DEMO_EXPIRED_AT = "2020-01-01T00:00:00.000Z";

export function setDemoLogin(enabled: boolean, expiresAt: string = DEMO_EXPIRES_AT): void {
  if (enabled) {
    process.env["DEMO_LOGIN_EMAIL"] = DEMO_EMAIL;
    process.env["DEMO_LOGIN_OTP"] = DEMO_OTP;
    process.env["DEMO_LOGIN_EXPIRES_AT"] = expiresAt;
  } else {
    delete process.env["DEMO_LOGIN_EMAIL"];
    delete process.env["DEMO_LOGIN_OTP"];
    delete process.env["DEMO_LOGIN_EXPIRES_AT"];
  }
  resetEnvCache(serverEnv);
}

/** Only one part set — the misconfiguration that must fail closed. */
export function setPartialDemoLogin(half: "email" | "otp" | "expiry"): void {
  setDemoLogin(false);
  if (half === "email") process.env["DEMO_LOGIN_EMAIL"] = DEMO_EMAIL;
  else if (half === "otp") process.env["DEMO_LOGIN_OTP"] = DEMO_OTP;
  else process.env["DEMO_LOGIN_EXPIRES_AT"] = DEMO_EXPIRES_AT;
  resetEnvCache(serverEnv);
}

/**
 * Set (or clear) `SITE_URL`.
 *
 * Needed by any suite that exercises an email-sending action: the invitation
 * links are absolute, and `@partybooth/env` memoises each variable the first
 * time it is read, so the cache has to be dropped alongside the value.
 */
export const TEST_SITE_URL = "https://partybooth.test";

export function setSiteUrl(value: string | undefined = TEST_SITE_URL): void {
  if (value === undefined) {
    delete process.env["SITE_URL"];
  } else {
    process.env["SITE_URL"] = value;
  }
  resetEnvCache(serverEnv);
}

/** Every audit row, newest last. */
export async function auditRows(t: T): Promise<Doc<"auditEvents">[]> {
  return await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
}

export async function auditActions(t: T): Promise<string[]> {
  return (await auditRows(t)).map((row) => row.action);
}

/**
 * A deterministic byte source, so a suite can force the code that comes out of
 * an allocation.
 *
 * `generateEventCode` draws one byte per digit through rejection sampling, so
 * feeding it the digit values directly (all well under the 250 rejection
 * threshold) produces exactly that code — and cycling the queue means a
 * collision-retry loop draws the same code again, which is what makes
 * "collision then success" testable at all.
 *
 * Longer draws are invite tokens. They get a counter-derived sequence so two
 * tokens minted in one test are never identical.
 */
export function bytesFor(digits: string): RandomBytes {
  const queue = [...digits].map((digit) => Number(digit));
  let digitIndex = 0;
  let tokenSeed = 0;
  return (length: number) => {
    if (length === 1) {
      const value = queue[digitIndex % queue.length] ?? 0;
      digitIndex += 1;
      return new Uint8Array([value]);
    }
    tokenSeed += 1;
    return new Uint8Array(Array.from({ length }, (_, index) => (tokenSeed * 31 + index * 7) % 256));
  };
}

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Point the push seam at an in-memory Expo for the duration of a test.
 *
 * Same contract as `useFakeStorage`: always pair it with `clearFakePush()` — or
 * the `afterEach` in the suite — because convex-test shares the module registry
 * across a file, and the override lives on `globalThis` so that the **action**
 * that dispatches sees it too.
 */
export function useFakePush(options: FakePushOptions = {}): FakePushAdapter {
  const adapter = createFakePushAdapter(options);
  setPushAdapterOverride(() => adapter);
  return adapter;
}

export function clearFakePush(): void {
  setPushAdapterOverride(undefined);
}

/** A valid-looking Expo push token. The shape `expoPushTokenSchema` accepts. */
export function pushToken(suffix: string): string {
  return `ExponentPushToken[${suffix}]`;
}

export async function seedPushDevice(
  t: T,
  userId: Id<"users">,
  over: { token?: string; platform?: Doc<"pushDevices">["platform"]; disabled?: boolean } = {},
): Promise<Id<"pushDevices">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("pushDevices", {
      userId,
      expoPushToken: over.token ?? pushToken(`seed-${Math.random().toString(36).slice(2, 10)}`),
      platform: over.platform ?? "ios",
      failureCount: 0,
      ...(over.disabled === true ? { disabledAt: now, disabledReason: "failureLimit" } : {}),
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** Every notification row, oldest first. */
export async function pushRows(t: T): Promise<Doc<"pushNotifications">[]> {
  return await t.run(async (ctx) => ctx.db.query("pushNotifications").collect());
}
