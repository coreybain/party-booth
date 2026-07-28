"use client";

import { CopyButton } from "@/components/events/copy-button";
import { QrCode } from "@/components/qr-code";
import { Callout } from "@/components/ui/callout";
import { Code } from "@/components/ui/code";
import { groupJoinCode, guestsCanJoin } from "@/lib/event-view";
import { displayUrl, joinFallbackUrl, joinUrl } from "@/lib/join-url";
import type { EventState } from "@/lib/contracts";

export interface InvitePanelProps {
  readonly code: string;
  /**
   * The QR credential. **Absent for a global admin**, who is served the code and
   * not the token — see `convex/invites.ts`. The panel degrades to the six
   * digits rather than pretending the QR failed to render.
   */
  readonly token?: string | undefined;
  readonly version: number;
  readonly state: EventState;
  readonly eventName: string;
}

/**
 * The thing the host holds up: a QR code and six digits.
 *
 * Both are generated **client-side** from data the host already has, so the
 * invite token never makes a second trip to a server and no third-party image
 * endpoint ever sees it.
 *
 * The QR encodes the absolute `/join/<token>` URL on the canonical origin, not
 * on whatever host this page happens to be served from. That is what makes the
 * universal link open the app rather than the browser — a Vercel preview
 * hostname is not in the app's associated domains, and a QR printed from a
 * preview deployment would silently lose the app hand-off.
 *
 * The token is deliberately never rendered as text. It is a bearer credential
 * and this screen gets photographed; a guest who can read the six digits has an
 * invitation that rotation can revoke, and one who can read the token has one
 * they can forward.
 */
export function InvitePanel({ code, token, version, state, eventName }: InvitePanelProps) {
  const url = token === undefined ? undefined : joinUrl(token);
  const fallback = joinFallbackUrl();
  const joinable = guestsCanJoin(state);

  return (
    <div className="space-y-4">
      {joinable ? null : (
        <Callout tone="warning">
          Nobody can use this code while the event is a draft. Schedule it or go live and it starts
          working immediately.
        </Callout>
      )}

      <div className="grid gap-5 sm:grid-cols-[minmax(0,13rem)_1fr] sm:items-start">
        <div className="mx-auto w-full max-w-[13rem]">
          {url === undefined ? (
            <div className="grid aspect-square place-items-center rounded-2xl border border-dashed border-line p-4 text-center text-sm text-muted">
              {token === undefined ? (
                <>The QR is shown to the host and co-hosts only. The six digits are here.</>
              ) : (
                <>
                  Set <Code>NEXT_PUBLIC_SITE_URL</Code> to generate the QR code.
                </>
              )}
            </div>
          ) : (
            <QrCode value={url} label={`QR code to join ${eventName}`} className="p-3" />
          )}
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted">Six-digit code</p>
            <p className="text-code mt-1 text-3xl font-semibold text-ink">{groupJoinCode(code)}</p>
            <p className="mt-1 text-sm text-faint">
              Invite #{version} · changing it is one tap in Settings, and kills the old QR.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <CopyButton value={code} label="Copy code" />
            {url === undefined ? null : <CopyButton value={url} label="Copy join link" />}
          </div>

          {fallback === undefined ? null : (
            <p className="text-sm text-muted">
              Guests who can't scan go to{" "}
              <span className="font-medium text-ink">{displayUrl(fallback)}</span> and type the six
              digits. Put both on the sign.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
