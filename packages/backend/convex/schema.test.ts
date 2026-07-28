import {
  ACCOUNT_STATES,
  AUDIT_ACTION_NAMES,
  EVENT_ROLES,
  EVENT_STATES,
  MEDIA_STATES,
  MEDIA_TYPES,
  MODERATION_MODES,
  STORAGE_REGIONS,
} from "@partybooth/contracts";
import { describe, expect, it } from "vitest";

import schema from "./schema";

type IndexDefinition = { indexDescriptor: string; fields: string[] };

/**
 * The schema is introspected rather than mirrored: these assertions are about
 * what Convex will actually create, not about a second copy of the intent.
 */
const tables = schema.tables as unknown as Record<
  string,
  | {
      indexes?: IndexDefinition[];
      validator: {
        fields: Record<string, { members?: { value: string }[]; value?: string } | undefined>;
      };
    }
  | undefined
>;

function indexesOf(table: string): IndexDefinition[] {
  const definition = tables[table];
  expect(definition, `table "${table}" should exist`).toBeDefined();
  return definition?.indexes ?? [];
}

function indexNames(table: string): string[] {
  return indexesOf(table).map((index) => index.indexDescriptor);
}

/**
 * The literal values a field accepts. A one-value enum (`storageRegion` today)
 * compiles to a bare `v.literal`, not a union, so both shapes are read here.
 */
function unionValues(table: string, field: string): string[] {
  const definition = tables[table];
  expect(definition, `table "${table}" should exist`).toBeDefined();
  const fieldValidator = definition?.validator.fields[field];
  expect(fieldValidator, `${table}.${field} should exist`).toBeDefined();
  if (fieldValidator?.members) {
    return fieldValidator.members.map((member) => member.value);
  }
  return fieldValidator?.value === undefined ? [] : [fieldValidator.value];
}

/* -------------------------------------------------------------------------- */

describe("tables", () => {
  it("declares exactly the tables the product has", () => {
    // TODO.md, Sprint 1: "Convex schema v1 — users, organiserInvitations,
    // events (incl. storageRegion), memberships, inviteVersions, media,
    // moderationDecisions, pushDevices, deletionJobs, auditEvents".
    expect(Object.keys(schema.tables).sort()).toEqual(
      [
        "auditEvents",
        "deletionJobs",
        "events",
        "inviteVersions",
        "media",
        "memberships",
        "moderationDecisions",
        "organiserInvitations",
        "pushDevices",
        "users",
        // Not in the Sprint 1 list, but required by it: "rate limits +
        // enumeration protection on ... OTP" cannot be enforced without a
        // shared counter, and Better Auth's default one is per-isolate.
        "otpChallenges",

        /* Sprint 2 ------------------------------------------------------- */
        // The join half of the same sentence. A six-digit code is a million
        // values; without a shared counter there is no throttle at all.
        "joinAttempts",
        // A co-host invited by email who has no account yet. `memberships`
        // cannot express it — its `userId` is required.
        "cohostInvitations",
        // Additional addresses proven by OTP, so an Apple private-relay user
        // has something for verified-email matching to match.
        "userEmails",
      ].sort(),
    );
  });

  it("does not redeclare Better Auth's own tables", () => {
    // They live inside the component; a local `user`/`session` table here would
    // silently shadow them.
    for (const reserved of ["user", "session", "account", "verification", "jwks"]) {
      expect(Object.keys(schema.tables)).not.toContain(reserved);
    }
  });
});

describe("enums come from @partybooth/contracts", () => {
  it.each([
    ["users", "accountState", ACCOUNT_STATES],
    ["events", "state", EVENT_STATES],
    ["events", "moderationMode", MODERATION_MODES],
    ["events", "storageRegion", STORAGE_REGIONS],
    ["memberships", "role", EVENT_ROLES],
    ["media", "state", MEDIA_STATES],
    ["media", "mediaType", MEDIA_TYPES],
    ["media", "storageRegion", STORAGE_REGIONS],
    ["auditEvents", "action", AUDIT_ACTION_NAMES],
  ])("%s.%s matches the contract", (table, field, expected) => {
    expect(unionValues(table, field)).toEqual([...expected]);
  });

  it("carries storageRegion on events, per PLAN.md", () => {
    expect(unionValues("events", "storageRegion")).toEqual(["pdx1"]);
  });
});

describe("indexes", () => {
  /**
   * Every list view in the product needs an index. A table scan is survivable
   * with ten rows and not survivable with a thousand photos and fifty guests
   * refreshing a gallery, so the access paths are asserted rather than assumed.
   */
  it.each([
    ["users", ["by_authId", "by_email", "by_accountState"]],
    ["organiserInvitations", ["by_email", "by_token", "by_status", "by_email_and_status"]],
    ["events", ["by_owner", "by_state", "by_owner_and_state"]],
    ["inviteVersions", ["by_event", "by_code", "by_token", "by_event_and_status"]],
    [
      "memberships",
      [
        "by_event",
        "by_user",
        "by_event_and_user",
        "by_event_and_status",
        "by_event_and_role",
        // `events.myEvents` — every event one person can walk into.
        "by_user_and_status",
      ],
    ],
    ["media", ["by_event", "by_event_and_state", "by_event_and_capture", "by_uploader"]],
    ["moderationDecisions", ["by_media", "by_event"]],
    ["pushDevices", ["by_user", "by_token"]],
    ["deletionJobs", ["by_state", "by_subject"]],
    ["auditEvents", ["by_action", "by_actor", "by_event", "by_subject"]],
    ["joinAttempts", ["by_key"]],
    ["cohostInvitations", ["by_email", "by_event", "by_event_and_email", "by_email_and_status"]],
    ["userEmails", ["by_user", "by_email", "by_user_and_email", "by_email_and_status"]],
  ])("%s has the indexes its access paths need", (table, required) => {
    const names = indexNames(table);
    for (const index of required) {
      expect(names, `${table} is missing ${index}`).toContain(index);
    }
  });

  it("can look up an invite by code and by token", () => {
    // The two halves of joining: typing the six-digit code, and scanning the QR.
    const byCode = indexesOf("inviteVersions").find((i) => i.indexDescriptor === "by_code");
    const byToken = indexesOf("inviteVersions").find((i) => i.indexDescriptor === "by_token");
    expect(byCode?.fields).toContain("code");
    expect(byToken?.fields).toContain("token");
  });

  it("can find a media row by (event, captureId) for idempotent callbacks", () => {
    const index = indexesOf("media").find((i) => i.indexDescriptor === "by_event_and_capture");
    expect(index?.fields).toEqual(["eventId", "captureId"]);
  });

  it("names every index by_<fields>", () => {
    for (const table of Object.keys(schema.tables)) {
      for (const name of indexNames(table)) {
        expect(name, `${table}.${name}`).toMatch(/^by_[A-Za-z_]+$/);
      }
    }
  });

  it("gives every table at least one index", () => {
    for (const table of Object.keys(schema.tables)) {
      expect(indexNames(table).length, `${table} has no index`).toBeGreaterThan(0);
    }
  });
});
