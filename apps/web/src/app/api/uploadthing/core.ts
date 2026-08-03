import "server-only";

/**
 * The UploadThing FileRouter — the only place in PartyBooth that is allowed to
 * put bytes into storage.
 *
 * Two routes share this authorised boundary. `partyMedia` is deliberately
 * **media-type agnostic** (image and video), while `avatarImage` accepts only a
 * separately granted, re-encoded JPEG. Keeping the routes separate prevents an
 * account-level avatar grant from inheriting an event media limit or lifecycle.
 *
 * ## What the middleware is, and what it is not
 *
 * It is a **gate**, not the authority. Five things happen before an upload URL
 * exists, cheapest first:
 *
 * 1. the deployment is checked for credentials, so a misconfigured party fails
 *    at the first photo with a sentence naming the variable rather than filling
 *    storage with objects nothing will ever complete;
 * 2. the ticket is parsed and cross-checked against the file actually offered
 *    (`checkTicketAgainstFiles`), which catches an honest client's bug and a
 *    lazy attacker's swap without a network round trip;
 * 3. the ticket is sanity-checked against `validateMediaFile` — a cheap local
 *    refusal that saves a round trip, and **not** a cap, because every value in
 *    it came from the client;
 * 4. the grant is checked **with Convex**, as the signed-in guest, via
 *    `media.confirmUpload`;
 * 5. the ticket is compared against what that grant actually authorised, and
 *    `validateMediaFile` is run again on **those** values.
 *
 * Step 4 is the one that matters, and it is worth being precise about what it
 * proves. `confirmUpload` looks the grant up by hash, refuses a secret belonging
 * to somebody else, refuses one whose two minutes have run out, and returns the
 * media row for `(eventId, captureId)` — creating it in `processing` if this is
 * the first anyone has heard of the capture. So a request that survives it has
 * demonstrated a live, unexpired grant that belongs to the authenticated caller.
 *
 * Step 5 is what makes step 3 mean anything, and it was missing. Every value
 * step 3 compared came from the client on both sides — `ticket.byteSize` against
 * `MEDIA_LIMITS`, `ticket.mediaType` choosing which limit — so a guest holding a
 * legitimate 1 MB photo grant could send a ticket declaring
 * `mediaType: "video", mimeType: "video/mp4", byteSize: 250 MB`, be routed to
 * the 256 MB `video` slot, and have a quarter of a gigabyte written to
 * storage before Convex refused it on the way back out and scheduled the delete.
 * At sixty grants per five minutes that is fifteen gigabytes of transient stored
 * bytes and paid egress per guest, on the guaranteed party-night path.
 * `confirmUpload` now answers with the grant's own `mediaType`, `byteSize` and
 * `mimeType`, and a ticket that disagrees with any of them is refused here —
 * before the presigned URL exists.
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
 * ## Derivatives
 *
 * Since Sprint 4 the same route also carries **previews and posters** (ADR
 * 0008). A derivative is its own single-use grant under the same `captureId`,
 * so nothing about the flow above changes except the two places where "which
 * artefact is this?" decides the answer: the state a settled row is allowed to
 * be in, and the byte ceiling. Both read `fileRole` off `confirmUpload`'s reply
 * rather than off the ticket, for the reason step 5 exists at all — the ticket's
 * copy is a client's claim, and a preview relabelled `original` at the edge
 * would be measured against 20 MB instead of two.
 *
 * ## Storage ACL
 *
 * `UPLOADTHING_ACL` declares `private` or `public-read` per file type rather
 * than inheriting a dashboard default. It is intentionally independent of the
 * deployment label so staging can exercise either provider tier; the schema
 * defaults an unset value to `private`.
 */

import { UploadThingError } from "@uploadthing/shared";
import { createUploadthing, type FileRouter } from "uploadthing/next";

import { fetchAuthMutation } from "@/lib/auth-server";
import {
  AVATAR_UPLOAD_ROUTE_SLUG,
  avatarUploadTicketSchema,
  checkTicketAgainstFiles,
  checkTicketAgainstGrant,
  isDerivativeRole,
  uploadTicketSchema,
  validateMediaFile,
  type MediaFileRole,
  type MediaType,
  type AvatarUploadTicket,
  type IssuedAvatarUploadGrant,
  type UploadTicket,
} from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { authoriseAvatarUploadAtEdge } from "@/lib/upload/avatar";
import { configuredUploadAcl } from "@/lib/upload/acl";
import {
  registerCompletedAvatarUpload,
  registerCompletedUpload,
  uploadServerStatus,
} from "@/lib/upload/server";

/**
 * What the middleware passes forward to `onUploadComplete`.
 *
 * Deliberately narrower than the ticket, but it does carry `checksum`. That is a
 * change: it used to be dropped here on the argument that both sides of the
 * comparison originate on the client, which is true and still leaves the
 * documented control — "the checksum lets the callback reject a swapped body",
 * `schemas.ts` and ADR 0004 — reading as implemented when nothing exercised it.
 * `matchesGrant` compares a checksum only when the completion carries one, and
 * no completion ever did, so the entire content binding was byte length. It
 * catches an inconsistent client rather than a determined one; the binding a
 * determined client cannot walk around is the byte size the grant was capped at,
 * now checked in the middleware as well as in `matchesGrant`.
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
  readonly checksum: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
};

function callbackMetadataFor(ticket: UploadTicket): UploadCallbackMetadata {
  return {
    secret: ticket.secret,
    eventId: ticket.eventId,
    captureId: ticket.captureId,
    checksum: ticket.checksum,
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
const uploadAcl = configuredUploadAcl();

const partyMediaConfig = {
  image: { maxFileSize: "32MB", maxFileCount: 1, acl: uploadAcl },
  video: { maxFileSize: "256MB", maxFileCount: 1, acl: uploadAcl },
} as const;

/** Avatars are a separately authorised, re-encoded JPEG route under the same ACL. */
const avatarConfig = {
  image: { maxFileSize: "2MB", maxFileCount: 1, acl: uploadAcl },
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

      // Cheap and local, and *only* that: both sides came from the client, so
      // this saves a round trip on an honest client's bug and proves nothing
      // about a dishonest one. The authoritative version is below, against the
      // grant.
      const claimed = validateMediaFile({
        mediaType: ticket.mediaType,
        // The ticket's own claim about which artefact it is. It selects the cap
        // *and* whether a duration is required at all — a video's poster is a
        // still frame and has none, so omitting the role here refuses every
        // poster with "video duration is required".
        fileRole: ticket.fileRole,
        byteSize: ticket.byteSize,
        mimeType: ticket.mimeType,
        durationSeconds: ticket.durationSeconds,
      });
      if (!claimed.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: claimed.message });
      }

      // The grant check. Runs as the signed-in guest: `fetchAuthMutation`
      // exchanges the first-party session cookie the browser sent with this
      // request for a Convex identity token, so a secret stolen from somebody
      // else's device is refused by Convex rather than trusted by us.
      const confirmed = await confirmGrant(ticket.secret);

      /*
       * A **derivative** is judged by a different rule, and it has to be.
       *
       * The original's rule is "the row must be `processing`", because a settled
       * row already has its file and there is nothing for more bytes to become.
       * A preview or a poster is the opposite case by construction (ADR 0008):
       * it is sent *after* its original landed, so its row is `pending` or
       * `approved` every single time, and the original's rule would refuse every
       * derivative this app has ever produced with "that photo has already been
       * sent". Nor is `mediaId === null` a failure here — it means the
       * original's own confirmation is still in flight, which `confirmUpload`
       * documents as normal for a derivative and which the completion path
       * reconciles in either order.
       *
       * Two things still refuse: a withdrawn capture (withdrawal is permanent
       * and `media.withdraw` expires every unspent grant precisely so nothing
       * can attach afterwards), and the size/role binding below, which is where
       * a preview is held to 2 MiB instead of 20 MB.
       */
      const fileRole: MediaFileRole = confirmed.fileRole ?? "original";
      const derivative = isDerivativeRole(fileRole);

      if (confirmed.state === "deleted") {
        throw new UploadThingError({
          code: "BAD_REQUEST",
          message: "That was withdrawn and cannot be sent again.",
        });
      }

      if (!derivative) {
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
          // A settled row means this capture already has its file. Storing the
          // bytes first and deleting them afterwards is strictly worse than not
          // storing them.
          throw new UploadThingError({
            code: "BAD_REQUEST",
            message: "That photo has already been sent.",
          });
        }
      }

      /*
       * The ticket against the grant it names. This is the only comparison in
       * the middleware with a server-minted value on one side, and it is what
       * stops a 1 MB photo grant from authorising a 250 MB "video" upload.
       *
       * A disagreement is not a size error to explain; it is a client
       * describing a different file from the one it was authorised to send, so
       * it gets the same sentence a swapped body gets and no detail about which
       * field gave it away.
       */
      if (confirmed.mediaType === null || confirmed.byteSize === null) {
        throw new UploadThingError({
          code: "BAD_REQUEST",
          message: "That upload is no longer valid. Take the photo again.",
        });
      }

      const authorised = {
        mediaType: confirmed.mediaType,
        // The role is part of the binding, not decoration: without it a preview
        // grant re-labelled `original` at the edge would be measured against
        // 20 MB instead of 2 MiB, which is the whole reason `confirmUpload`
        // answers with it.
        fileRole,
        byteSize: confirmed.byteSize,
        ...(confirmed.mimeType === null ? {} : { mimeType: confirmed.mimeType }),
      };

      // The comparison itself lives in `@partybooth/contracts` rather than here,
      // for the reason the ticket does: it is a rule, it has to be verifiable
      // with no deployment and no credentials, and a rule that only exists
      // inside a route handler is a rule with no test.
      const bound = checkTicketAgainstGrant(ticket, authorised);
      if (!bound.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: bound.message });
      }

      // …and the caps, applied to the grant's own facts rather than to the
      // ticket's. `MEDIA_LIMITS` is the same table Convex consulted when it
      // issued the grant, so this cannot disagree with it — which is the point:
      // it is a backstop against a grant issued under an older limit, not a
      // second opinion.
      const capped = validateMediaFile({
        mediaType: authorised.mediaType,
        fileRole: authorised.fileRole,
        byteSize: authorised.byteSize,
        mimeType: authorised.mimeType ?? ticket.mimeType,
        durationSeconds: ticket.durationSeconds,
      });
      if (!capped.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: capped.message });
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
        // Forwarded so `matchesGrant` actually runs the comparison the design
        // documents. It is the ticket's value, so it catches a client that
        // hashed one body and sent another, not one that lies consistently.
        checksum: metadata.checksum,
        ...(typeof metadata.width === "number" ? { width: metadata.width } : {}),
        ...(typeof metadata.height === "number" ? { height: metadata.height } : {}),
        /*
         * The client's duration, forwarded **as a claim** and not as a check.
         *
         * This used to be described as the "landed-object duration" that made
         * the 60-second cap real a second time, and it never was: it is
         * `ticket.durationSeconds`, copied out of the client-authored upload
         * ticket by `callbackMetadataFor` above, so Convex re-reading it was
         * reading the same claim twice. A modified client could declare eight
         * seconds and store a ten-minute recording under the 250 MB ceiling.
         *
         * It is preserved rather than clamped, because it is what the recorder
         * believed and a host seeing "8s" on a ten-minute file is a useful
         * discrepancy. What actually enforces the cap is
         * `media.verifyVideoDuration`, scheduled by `completeUpload`, which
         * fetches the stored object's own header and reads the container's
         * duration — the one number in this path with a server on the other side
         * of it. It overwrites this value on the row when it agrees, and deletes
         * the object when it does not.
         */
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
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }),
  [AVATAR_UPLOAD_ROUTE_SLUG]: f(avatarConfig, { awaitServerData: true })
    .input(avatarUploadTicketSchema)
    .middleware(async ({ files, input }) => {
      const status = uploadServerStatus();
      if (!status.ready) {
        throw new UploadThingError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Uploads are not configured yet (missing ${status.missing.join(", ")}).`,
        });
      }

      const ticket: AvatarUploadTicket = input;
      const confirmed = await confirmAvatarGrant(ticket.secret);
      const authorised = authoriseAvatarUploadAtEdge(ticket, files, confirmed);
      if (!authorised.ok) {
        throw new UploadThingError({ code: "BAD_REQUEST", message: authorised.message });
      }

      return { secret: ticket.secret, checksum: ticket.checksum };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const result = await registerCompletedAvatarUpload({
        secret: metadata.secret,
        fileKey: file.key,
        byteSize: file.size,
        mimeType: file.type,
        checksum: metadata.checksum,
      });

      // Never return the durable provider key as UploadThing serverData.
      return { outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) };
    }),
} satisfies FileRouter;

export type PartyBoothFileRouter = typeof partyBoothFileRouter;

/**
 * `media.confirmUpload`, with the "no backend" branch hoisted out of the
 * middleware so the narrowing survives the `await`.
 */
async function confirmGrant(secret: string): Promise<{
  mediaId: string | null;
  state: string | null;
  /** What the grant authorised. Server-minted — the only trustworthy values here. */
  mediaType: MediaType | null;
  fileRole: MediaFileRole | null;
  byteSize: number | null;
  mimeType: string | null;
}> {
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

/** Avatar equivalent of `confirmGrant`, with the same deliberately vague refusal. */
async function confirmAvatarGrant(
  secret: string,
): Promise<Pick<IssuedAvatarUploadGrant, "byteSize" | "mimeType" | "checksum">> {
  if (!fetchAuthMutation) {
    throw new UploadThingError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Uploads are not configured yet (missing CONVEX_URL).",
    });
  }

  try {
    return await fetchAuthMutation(backendApi.avatars.confirmUpload, { secret });
  } catch {
    throw new UploadThingError({
      code: "FORBIDDEN",
      message: "That profile photo upload is no longer valid. Try again.",
    });
  }
}
