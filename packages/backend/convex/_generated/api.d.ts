/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as avatars from "../avatars.js";
import type * as blocks from "../blocks.js";
import type * as cohosts from "../cohosts.js";
import type * as crons from "../crons.js";
import type * as deletion from "../deletion.js";
import type * as demo from "../demo.js";
import type * as emails from "../emails.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as join from "../join.js";
import type * as lib_account_deletion from "../lib/account_deletion.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_avatar_grants from "../lib/avatar_grants.js";
import type * as lib_blocks from "../lib/blocks.js";
import type * as lib_config from "../lib/config.js";
import type * as lib_email_console from "../lib/email/console.js";
import type * as lib_email_index from "../lib/email/index.js";
import type * as lib_email_resend from "../lib/email/resend.js";
import type * as lib_email_templates from "../lib/email/templates.js";
import type * as lib_email_types from "../lib/email/types.js";
import type * as lib_email_matching from "../lib/email_matching.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_guards from "../lib/guards.js";
import type * as lib_hash from "../lib/hash.js";
import type * as lib_input from "../lib/input.js";
import type * as lib_join_throttle from "../lib/join_throttle.js";
import type * as lib_lock from "../lib/lock.js";
import type * as lib_media from "../lib/media.js";
import type * as lib_moderation from "../lib/moderation.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_otp from "../lib/otp.js";
import type * as lib_otp_throttle from "../lib/otp_throttle.js";
import type * as lib_profile from "../lib/profile.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_push_adapter from "../lib/push/adapter.js";
import type * as lib_push_expo from "../lib/push/expo.js";
import type * as lib_push_fake from "../lib/push/fake.js";
import type * as lib_push_index from "../lib/push/index.js";
import type * as lib_rotation_throttle from "../lib/rotation_throttle.js";
import type * as lib_sentry from "../lib/sentry.js";
import type * as lib_storage_adapter from "../lib/storage/adapter.js";
import type * as lib_storage_fake from "../lib/storage/fake.js";
import type * as lib_storage_index from "../lib/storage/index.js";
import type * as lib_storage_uploadthing from "../lib/storage/uploadthing.js";
import type * as lib_storage_purge from "../lib/storage_purge.js";
import type * as lib_upload_callback from "../lib/upload_callback.js";
import type * as lib_upload_grants from "../lib/upload_grants.js";
import type * as lib_upload_throttle from "../lib/upload_throttle.js";
import type * as lib_user_mirror from "../lib/user_mirror.js";
import type * as lib_validators from "../lib/validators.js";
import type * as media from "../media.js";
import type * as memberships from "../memberships.js";
import type * as moderation from "../moderation.js";
import type * as organiser_invitations from "../organiser_invitations.js";
import type * as otp from "../otp.js";
import type * as push from "../push.js";
import type * as slideshow from "../slideshow.js";
import type * as stats from "../stats.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  avatars: typeof avatars;
  blocks: typeof blocks;
  cohosts: typeof cohosts;
  crons: typeof crons;
  deletion: typeof deletion;
  demo: typeof demo;
  emails: typeof emails;
  events: typeof events;
  http: typeof http;
  invites: typeof invites;
  join: typeof join;
  "lib/account_deletion": typeof lib_account_deletion;
  "lib/audit": typeof lib_audit;
  "lib/avatar_grants": typeof lib_avatar_grants;
  "lib/blocks": typeof lib_blocks;
  "lib/config": typeof lib_config;
  "lib/email/console": typeof lib_email_console;
  "lib/email/index": typeof lib_email_index;
  "lib/email/resend": typeof lib_email_resend;
  "lib/email/templates": typeof lib_email_templates;
  "lib/email/types": typeof lib_email_types;
  "lib/email_matching": typeof lib_email_matching;
  "lib/errors": typeof lib_errors;
  "lib/events": typeof lib_events;
  "lib/guards": typeof lib_guards;
  "lib/hash": typeof lib_hash;
  "lib/input": typeof lib_input;
  "lib/join_throttle": typeof lib_join_throttle;
  "lib/lock": typeof lib_lock;
  "lib/media": typeof lib_media;
  "lib/moderation": typeof lib_moderation;
  "lib/notifications": typeof lib_notifications;
  "lib/otp": typeof lib_otp;
  "lib/otp_throttle": typeof lib_otp_throttle;
  "lib/profile": typeof lib_profile;
  "lib/providers": typeof lib_providers;
  "lib/push/adapter": typeof lib_push_adapter;
  "lib/push/expo": typeof lib_push_expo;
  "lib/push/fake": typeof lib_push_fake;
  "lib/push/index": typeof lib_push_index;
  "lib/rotation_throttle": typeof lib_rotation_throttle;
  "lib/sentry": typeof lib_sentry;
  "lib/storage/adapter": typeof lib_storage_adapter;
  "lib/storage/fake": typeof lib_storage_fake;
  "lib/storage/index": typeof lib_storage_index;
  "lib/storage/uploadthing": typeof lib_storage_uploadthing;
  "lib/storage_purge": typeof lib_storage_purge;
  "lib/upload_callback": typeof lib_upload_callback;
  "lib/upload_grants": typeof lib_upload_grants;
  "lib/upload_throttle": typeof lib_upload_throttle;
  "lib/user_mirror": typeof lib_user_mirror;
  "lib/validators": typeof lib_validators;
  media: typeof media;
  memberships: typeof memberships;
  moderation: typeof moderation;
  organiser_invitations: typeof organiser_invitations;
  otp: typeof otp;
  push: typeof push;
  slideshow: typeof slideshow;
  stats: typeof stats;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
