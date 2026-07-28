import { z } from "zod";

import { toAppErrorView } from "@/lib/app-errors";
import { fetchAuthMutation } from "@/lib/auth-server";
import { joinInputSchema } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";
import { clientNetworkKey } from "@/lib/network-key";

import type { JoinApiResponse } from "@/lib/join-transport";

/**
 * `POST /api/join` — the server-side origin the join throttle needs.
 *
 * Both code-shaped calls (`join.join` and `join.previewByCode`) go through here
 * rather than straight over the Convex WebSocket, for one reason: a socket call
 * has no client address, so the throttle's second axis had no honest caller and
 * the effective ceiling was ten guesses per *disposable account* — and accounts
 * are free (Google sign-in or an email OTP). This handler is in the request
 * path, so it can derive the key from the forwarded address, and the browser
 * cannot decline to send it.
 *
 * The key is passed to Convex opaquely and hashed there; no throttle row ever
 * holds an address. Convex still treats it as untrusted — it can only add a key
 * to be throttled on, never remove the account one — which is what keeps the
 * Expo app, which has no server in front of it, working on the account axis
 * alone.
 *
 * Authentication is not re-implemented here. `fetchAuthMutation` exchanges the
 * first-party session cookie for a Convex identity token, and every gate that
 * matters (`requireActiveUser`, the throttle, the audit rows) is still enforced
 * inside the mutation. This route adds an argument; it does not grant anything.
 */

/** Sessions live in cookies, so this can never be static or cached. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), invite: joinInputSchema }),
  // Not `eventCodeSchema`: normalising and validating the code is Convex's job,
  // and a second opinion here would be a second place for the two to disagree
  // about what "that is not a code" looks like. Length-capped so a megabyte of
  // junk cannot be forwarded.
  z.object({ action: z.literal("previewByCode"), code: z.string().max(64) }),
]);

function json(body: JoinApiResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!fetchAuthMutation) {
    return json(
      {
        ok: false,
        error: {
          code: "unknown",
          message: "The backend is not configured yet, so joining is unavailable.",
        },
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // Deliberately vague and identical for every malformed shape: this endpoint
    // sits in front of the one flow whose whole design is "every failure looks
    // the same".
    return json(
      { ok: false, error: { code: "invalidInput", message: "That invite is not usable." } },
      400,
    );
  }

  const networkKey = clientNetworkKey(request.headers);

  try {
    if (parsed.data.action === "join") {
      const result = await fetchAuthMutation(backendApi.join.join, {
        invite: parsed.data.invite,
        ...(networkKey === undefined ? {} : { networkKey }),
      });
      return json({ ok: true, result }, 200);
    }

    const result = await fetchAuthMutation(backendApi.join.previewByCode, {
      code: parsed.data.code,
      ...(networkKey === undefined ? {} : { networkKey }),
    });
    return json({ ok: true, result }, 200);
  } catch (error) {
    // `ConvexError` does not survive JSON, so the view crosses instead and the
    // client rethrows it as a `RemoteAppError`. Status stays 200-adjacent at 400
    // rather than 500: these are expected outcomes (signed out, locked account),
    // not faults.
    return json({ ok: false, error: toAppErrorView(error) }, 400);
  }
}
