/**
 * The invite a guest was holding when they were sent to sign in.
 *
 * The QR path has an unavoidable interruption in it: scan a sign → the app opens on
 * `/join/<token>` → the guest is signed out → OAuth. Without somewhere to put the
 * invite, they come back signed in and looking at an empty Camera tab, having done
 * nothing wrong. That is the single most likely way to lose someone at the door.
 *
 * Module state, not storage, and that is deliberate:
 *
 *   - The OAuth round trip uses an in-app browser sheet, so the JS context survives it.
 *     Anything that does *not* survive it (a cold start, a crash) also means the guest
 *     is still standing next to the sign they scanned — re-scanning costs two seconds,
 *     and persisting an invite would mean a token sitting on disk after it is spent.
 *   - An invite token is a bearer credential. The less durable its storage, the better.
 *
 * `take` clears as it reads: an invite is consumed once, so a later navigation cannot
 * bounce the guest back into a join screen they have already been through.
 */

import type { JoinTarget } from "./deep-links";

let pending: JoinTarget | null = null;

/** Remember an invite across a sign-in detour. `null` forgets it. */
export function rememberPendingInvite(target: JoinTarget | null): void {
  pending = target;
}

/** Read and clear. Returns `null` when there was nothing waiting. */
export function takePendingInvite(): JoinTarget | null {
  const target = pending;
  pending = null;
  return target;
}

/** Read without clearing — for a gate that has not decided to act on it yet. */
export function peekPendingInvite(): JoinTarget | null {
  return pending;
}

/**
 * The route parameter that carries an invite.
 *
 * `/join/[token]` accepts both shapes: `parseJoinLink` classifies the segment, so a
 * six-digit code arriving here is routed to the code path rather than being mistaken
 * for a very short token.
 */
export function pendingInviteParam(target: JoinTarget): string {
  return target.kind === "token" ? target.token : target.code;
}
