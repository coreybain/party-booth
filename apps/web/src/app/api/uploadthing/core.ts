import "server-only";

/**
 * The UploadThing FileRouter — the only place in PartyBooth that is allowed to
 * put bytes into private storage.
 *
 * One route, `partyMedia`, and it is deliberately **media-type agnostic**: it
 * accepts `image` and `video` from day one even though video capture is Sprint 4
 * (PLAN.md). `MEDIA_LIMITS` in `@partybooth/contracts` already knows what a
 * video may weigh and how long it may run, and a route that only learns about
 * video when a camera screen ships is a route whose validation gets written
 * twice.
 *
 * ## What the middleware is, and what it is not
 *
 * It is a **gate**, not the authority. Four things happen before an upload URL
 * exists, cheapest first:
 *
 * 1. the deployment is checked for credentials, so a misconfigured party fails
 *    at the first photo with a sentence naming the variable rather than filling
 *    storage with objects nothing will ever complete;
 * 2. the ticket is parsed and cross-checked against the file actually offered
 *    (`checkTicketAgainstFiles`), which catches an honest client's bug and a
 *    lazy attacker's swap without a network round trip;
 * 3. the file is re-validated against `validateMediaFile` — the same function
 *    Convex runs — so the 20 MB photo cap is enforced here as well as there;
 * 4. the grant is checked **with Convex**, as the signed-in guest, via
 *    `media.confirmUpload`.
 *
 * Step 4 is the one that matters, and it is worth being precise about what it
 * proves. `confirmUpload` looks the grant up by hash, refuses a secret belonging
 * to somebody else, refuses one whose two minutes have run out, and returns the
 * media row for `(eventId, captureId)` — creating it in `processing` if this is
 * the first anyone has heard of the capture. So a request that survives it has
 * demonstrated a live, unexpired grant that belongs to the authenticated caller.
 *
 * What it does **not** do is spend the grant. Single use is enforced inside
 * `media.completeUpload`, in one Convex transaction, and that is not an
 * implementation detail that could move here: Convex's serialisable
 * read-decide-write is *what makes* single use true, and a check in a route
 * handler that a second request can race is not a check (ADR 0004 §1). What this
 * middleware adds is a fast, honest refusal at the edge — a grant whose capture
 * has already been settled comes back in a state other than `processing`, so a
 * replay is turned away before any bytes move.
 *
 * ## Private ACL
 *
 * `acl: "private"` is declared here, per file type, rather than inherited from
 * the app's dashboard default. PLAN.md makes private ACLs a non-negotiable
 * invariant, and an invariant that lives only in a dashboard checkbox is one
 * that a dashboard mis-click silently revokes for every photo taken afterwards.
 * Declaring it means the code asserts the property. (It does require "allow ACL
 * override" to be enabled on the UploadThing app — see the owner-action list.)
 */

import { UploadThingError } from "@uploadthing/shared";
import { createUploadthing, type FileRouter } from "uploadthing/next";

import { fetchAuthMutation } from "@/lib/auth-server";
import {
  checkTicketAgainstFiles,
  uploadTicketSchema,
  validateMediaFile,
  type UploadTicket,
} from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { registerCompletedUpload, uploadServerStatus } from "@/lib/upload/server";

/**
 * What the middleware passes forward to `onUploadComplete`.
 *
 * Deliberately narrower than the ticket: the completion call needs the grant and
 * the shape facts, and nothing is served by carrying a checksum the client
 * supplied twice — Convex already holds the one the grant was minted with, and
 * comparing a value against itself is not a check.
 *
 * A `type`, not an `interface`, and that is load-bearing: UploadThing's
 * `ValidMiddlewareObject` is `{ [key: string]: unknown }`, and TypeScript only
 * gives implicit index signatures to type aliases. An interface here would
 * either fail to satisfy the constraint or need an explicit
 * `[key: string]: unknown` — which would then widen every field back to
 * `unknown` at the `onUploadComplete` end, exactly where the secret has to still
 * be a string. It lives in this file rather than in `@partybooth/contracts`
 * because it is a shape UploadThing's types impose, not one our clients share.
 */
type UploadCallbackMetadata = {
  readonly secret: string;
  readonly eventId: string;
  readonly captureId: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
};

function callbackMetadataFor(ticket: UploadTicket): UploadCallbackMetadata {
  return {
    secret: ticket.secret,
    eventId: ticket.eventId,
    captureId: ticket.captureId,
    ...(ticket.width === undefined ? {} : { width: ticket.width }),
    ...(ticket.height === undefined ? {} : { height: ticket.height }),
    ...(ticket.durationSeconds === undefined ? {} : { durationSeconds: ticket.durationSeconds }),
  };
}

const f = createUploadthing();

/**
 * UploadThing's own ceilings, which are the only size limit enforced by
 * something other than a value the client supplied.
 *
 * They are looser than PartyBooth's (20 MB photos, 250 MB video) because the
 * option's type only admits powers of two: 32MB is the smallest value that does
 * not reject a legitimate 20 MB photo. The real caps are `MEDIA_LIMITS`, applied
 * in the middleware below and again inside `media.requestUploadGrant`; this is
 * the backstop that catches a client lying about `byteSize`, and it bounds the
 * damage at 32 MB rather than at whatever the phone felt like sending.
 */
const partyMediaConfig = {
  image: { maxFileSize: "32MB", maxFileCount: 1, acl: "private" },
  video: { maxFileSize: "256MB", maxFileCount: 1, acl: "private" },
} as const;

export const partyBoothFileRouter = {
  partyMedia: f(partyMediaConfig, {
    /**
     * The browser waits for `onUploadComplete` to return.
     *
     * Worth the extra round trip here: it is what lets the guest's spinner turn
     * into "waiting for the host to approve it" — the actual media state — the
     * moment the upload finishes, instead of "sent, probably". At a party, "did
     * that work?" is the only question a guest has.
     */
    awaitServerData: true,
  })
    // Zod 4 schemas are Standard Schema, which `.input()` accepts directly.
    .input(uploadTicketSchema)
    .middleware(async ({ files, input }) => {
      const status = uploadServerStatus();
      if (!status.ready) {
        // Named, because the person who sees this in a preview deployment is the
        // one who can go and set it.
        throw new UploadThingError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Uploads are not configured yet (missing ${status.missing.join(", ")}).`,
        });
      }
      if (!fetchAuthMutation) {
        throw new UploadThingError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Uploads are not configured yet (missing CONVEX_URL).",
        });
      }

      const ticket: UploadTicket = input;

      const match = checkTicketAgainstFiles(ticket, files);
      if (!match.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: match.message });
      }

      const file = validateMediaFile({
        mediaType: ticket.mediaType,
        byteSize: ticket.byteSize,
        mimeType: ticket.mimeType,
        durationSeconds: ticket.durationSeconds,
      });
      if (!file.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: file.message });
      }

      // The grant check. Runs as the signed-in guest: `fetchAuthMutation`
      // exchanges the first-party session cookie the browser sent with this
      // request for a Convex identity token, so a secret stolen from somebody
      // else's device is refused by Convex rather than trusted by us.
      const confirmed = await confirmGrant(ticket.secret);

      if (confirmed.mediaId === null || confirmed.state === null) {
        // The grant ran out between being issued and the first byte. Two
        // minutes is generous for that, so this is a slow phone or a long
        // re-encode, and the honest fix is a fresh grant — which the client
        // asks for automatically on retry.
        throw new UploadThingError({
          code: "BAD_REQUEST",
          message: "That upload took too long to start. Try sending it again.",
        });
      }

      if (confirmed.state !== "processing") {
        // A settled row means this capture already has its file (or was
        // withdrawn, which is permanent). Either way there is nothing for these
        // bytes to become, and storing them first and deleting them afterwards
        // is strictly worse than not storing them.
        throw new UploadThingError({
          code: "BAD_REQUEST",
          message:
            confirmed.state === "deleted"
              ? "That photo was withdrawn and cannot be sent again."
              : "That photo has already been sent.",
        });
      }

      return callbackMetadataFor(ticket);
    })
    .onUploadComplete(async ({ metadata, file }) => {
      /*
       * This runs in a **separate request**, made by UploadThing's servers to
       * our callback URL and verified against the app token's signature. There
       * is no session and no cookie here — which is exactly why
       * `media.completeUpload` authenticates on `UPLOAD_CALLBACK_SECRET` and
       * takes the acting user from the grant rather than from the request.
       *
       * `file.size` is forwarded rather than the ticket's `byteSize` so the
       * value Convex matches against the grant is the one that came back
       * through the provider, not the one this handler was told to expect.
       */
      const result = await registerCompletedUpload({
        secret: metadata.secret,
        fileKey: file.key,
        byteSize: file.size,
        mimeType: file.type,
        ...(typeof metadata.width === "number" ? { width: metadata.width } : {}),
        ...(typeof metadata.height === "number" ? { height: metadata.height } : {}),
        ...(typeof metadata.durationSeconds === "number"
          ? { durationSeconds: metadata.durationSeconds }
          : {}),
      });

      /*
       * All four outcomes return normally. A callback that answers with an
       * error is one UploadThing retries for ever, and three of the four
       * ("we already had this", "the guest withdrew it mid-flight", "that grant
       * is not one of ours") are conditions no number of retries will change —
       * Convex has already scheduled the deletion of anything it refused to
       * attach. Only a transport failure escapes, from inside
       * `registerCompletedUpload`, and that one *should* be retried.
       *
       * No file key crosses back to the browser. `serverData` reaches the client
       * verbatim, and a provider key is a durable pointer at a private object.
       */
      return {
        outcome: result.outcome,
        state: result.state ?? null,
      };
    }),
} satisfies FileRouter;

export type PartyBoothFileRouter = typeof partyBoothFileRouter;

/**
 * `media.confirmUpload`, with the "no backend" branch hoisted out of the
 * middleware so the narrowing survives the `await`.
 */
async function confirmGrant(
  secret: string,
): Promise<{ mediaId: string | null; state: string | null }> {
  if (!fetchAuthMutation) {
    throw new UploadThingError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Uploads are not configured yet (missing CONVEX_URL).",
    });
  }

  try {
    return await fetchAuthMutation(backendApi.media.confirmUpload, { secret });
  } catch {
    /*
     * Convex refused. The overwhelmingly likely causes are a signed-out session
     * and a secret that is not this account's, and those two must produce the
     * same sentence: `confirmUpload` answers `notFound` for both precisely so
     * the pair cannot be told apart, and a route handler that helpfully
     * distinguishes them undoes that.
     */
    throw new UploadThingError({
      code: "FORBIDDEN",
      message: "That upload is no longer valid. Take the photo again.",
    });
  }
}
