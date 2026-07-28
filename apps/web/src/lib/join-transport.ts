/**
 * The browser's side of `POST /api/join`.
 *
 * Both guest doors on the web — the QR page and the code form — used to call
 * `join.join` / `join.previewByCode` straight over the Convex WebSocket. That
 * works, and it left the join throttle with exactly one axis: the account. A
 * socket call has no client address to derive a second one from, and any value
 * the browser volunteers is a value the attacker picks, so the `networkKey`
 * argument the backend accepts had no honest caller anywhere in the repo.
 *
 * Routing the two code-shaped calls through a Next.js Route Handler is what
 * gives them a server-side origin: the handler reads the forwarded address,
 * passes it to Convex, and the browser cannot opt out of it. See
 * `src/lib/network-key.ts` and `app/api/join/route.ts`.
 *
 * `previewByToken` deliberately stays a direct Convex query. It is
 * unauthenticated, reactive, and a 160-bit token has nothing to enumerate.
 *
 * The Expo app still calls Convex directly and is charged on the account axis
 * alone — it has no server in front of it. That is a known and documented gap,
 * not an oversight; the account key is never removed, only added to.
 */

import { RemoteAppError, type AppErrorView } from "@/lib/app-errors";
import { parseJoinResult, type JoinResult } from "@/lib/contracts";

import type { EventId, JoinInvite, JoinPreview, MembershipId } from "@/lib/convex-api";

export const JOIN_API_PATH = "/api/join";

/** What the route handler accepts. Discriminated so one handler serves both. */
export type JoinApiRequest =
  | { readonly action: "join"; readonly invite: JoinInvite }
  | { readonly action: "previewByCode"; readonly code: string };

/** What it answers with. `ok: false` carries a view, never a stack. */
export type JoinApiResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: AppErrorView };

const OFFLINE: AppErrorView = {
  code: "unknown",
  message: "You look offline. Check your signal and try again.",
};

async function call(request: JoinApiRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(JOIN_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      // The session cookie is what the handler exchanges for a Convex token.
      credentials: "same-origin",
    });
  } catch {
    // A party runs on saturated Wi-Fi; this is the most likely failure there is.
    throw new RemoteAppError(OFFLINE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteAppError(OFFLINE);
  }

  const payload = body as Partial<JoinApiResponse>;
  if (payload.ok === true) return (payload as { result: unknown }).result;

  const error = (payload as { error?: AppErrorView }).error;
  throw new RemoteAppError(
    error && typeof error.message === "string"
      ? error
      : { code: "unknown", message: "Something went wrong. Try again in a moment." },
  );
}

/**
 * Attempt a join.
 *
 * The result is re-parsed with the contract's own schema rather than trusted:
 * it has now been through a JSON round trip as well as a hand-written type
 * assertion, and `parseJoinResult` fails **closed** — an unparseable answer is a
 * rejection, never a third distinguishable outcome.
 */
export async function requestJoin(invite: JoinInvite): Promise<JoinResult<EventId, MembershipId>> {
  return parseJoinResult(await call({ action: "join", invite }));
}

/**
 * Look a six-digit code up.
 *
 * `null` is the one answer for every failure — no such code, superseded version,
 * party not open, throttled. Anything unrecognised collapses to `null` too, for
 * the same reason the join parse fails closed.
 */
export async function requestPreviewByCode(code: string): Promise<JoinPreview | null> {
  const result = await call({ action: "previewByCode", code });
  if (result === null || typeof result !== "object") return null;
  const preview = result as JoinPreview;
  return typeof preview.eventId === "string" && typeof preview.name === "string" ? preview : null;
}
