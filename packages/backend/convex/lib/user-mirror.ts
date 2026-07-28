import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isAdminEmail } from "./config";
import { resolveDisplayName } from "./profile";

/**
 * Mirroring a Better Auth user into `users`.
 *
 * It lives here rather than inside `auth.ts` for one reason: `auth.ts` is a
 * Convex **function module**, so everything exported from it is scanned as an
 * entry point and a plain helper cannot be exported for a test to call. The
 * behaviour below is the difference between the reviewer landing in a seeded
 * party and landing in an empty shell, so it needs a test that runs offline.
 */

export interface MirrorInput {
  /** Better Auth's own id — provider-generated, and unpredictable from here. */
  readonly authId: string;
  /** Already trimmed and lower-cased by the caller. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly providerName?: string | null | undefined;
  readonly now: number;
}

/**
 * Create the mirror row for a new Better Auth user — **adopting** a seeded row
 * if one is waiting for that address.
 *
 * `demo.seedDemoEvent` has to build a whole party around the reviewer's account
 * before the reviewer has ever signed in, and it cannot reach into Better Auth's
 * tables to pre-create the user there. So it writes a mirror row with a
 * placeholder `authId` and `seeded: true`. When the reviewer signs in, Better
 * Auth mints its own id, the `user.onCreate` trigger fires, and — before this
 * existed — found nothing under that id and inserted a *second* mirror row. The
 * reviewer ended up in an account with no membership of the party that had just
 * been seeded for them, which is the whole point of seeding it.
 *
 * **Adoption is confined to rows carrying `seeded`**, and that is the entire
 * safety argument. Matching on address alone would mean any mirror row could be
 * claimed by whoever next signs up with that address — a much worse feature
 * wearing this one's clothes. A seeded row has never belonged to an
 * authentication and exists precisely to be claimed once; the flag is cleared on
 * adoption, so it cannot be claimed twice.
 */
export async function mirrorAuthUser(ctx: MutationCtx, input: MirrorInput): Promise<Id<"users">> {
  const existing = await findByEmail(ctx, input.email);

  if (existing?.seeded === true) {
    await ctx.db.patch(existing._id, {
      authId: input.authId,
      emailVerified: input.emailVerified || existing.emailVerified,
      // The seeded display name is a deliberate choice ("App Review"), so it
      // outranks whatever the provider supplies — the same rule `onUpdate`
      // applies through `resolveDisplayName`.
      displayName: resolveDisplayName({
        current: existing.displayName,
        providerName: input.providerName,
        onboardedAt: existing.onboardedAt,
      }),
      isPrivateRelayEmail: isPrivateRelayEmail(input.email),
      isGlobalAdmin: isAdminEmail(input.email),
      seeded: undefined,
      updatedAt: input.now,
    });
    return existing._id;
  }

  return await ctx.db.insert("users", {
    authId: input.authId,
    email: input.email,
    emailVerified: input.emailVerified,
    displayName: input.providerName?.trim() || defaultDisplayName(input.email),
    isPrivateRelayEmail: isPrivateRelayEmail(input.email),
    accountState: "active",
    // Private beta is invitation-only. Accepting an organiser invitation flips
    // this; nothing else may.
    isOrganiser: false,
    // Cached from the server-side allowlist — `isAdminEmail` stays the authority
    // on every check.
    isGlobalAdmin: isAdminEmail(input.email),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function findByEmail(ctx: MutationCtx, email: string): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
}

/**
 * Apple's private relay. Such an address cannot receive an organiser
 * invitation, which is why PLAN.md gives those users an OTP path to verify a
 * real address instead.
 */
export function isPrivateRelayEmail(email: string): boolean {
  return email.endsWith("@privaterelay.appleid.com");
}

/** A usable name before the user confirms one, e.g. "corey" from the address. */
export function defaultDisplayName(email: string): string {
  const [local] = email.split("@");
  return local && local.length > 0 ? local : "Guest";
}

export function normaliseEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
