"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { FlagIcon } from "@/components/icons";
import { Card, SectionHeading } from "@/components/layout/card";
import { MediaTile } from "@/components/media/media-tile";
import { Button } from "@/components/ui/button";
import { appErrorMessage } from "@/lib/app-errors";
import type { ModerationActionName } from "@/lib/contracts";
import { backendApi, type FlaggedItem } from "@/lib/convex-api";
import { formatRelative } from "@/lib/datetime";
import { canAct } from "@/lib/moderation/selection";
import { formatReportCount, REPORT_REASON_COPY } from "@/lib/moderation/reports";

/**
 * Reported items, above everything else on the page.
 *
 * PLAN.md's App Review line asks for a report flow; this is the half a host
 * sees, and it is a *panel* rather than a filter because prominence is the whole
 * point. A report is the one decision on the moderation screen with a clock on
 * it, and a host who finds out about a reported photo from a guest at the party
 * rather than from this screen has been failed by the screen.
 *
 * Two decisions worth stating:
 *
 * - **Reporters are never named.** `moderation.flagged` does not return who
 *   reported what, so there is nothing here to leak. The complaint text is
 *   shown because it is the only thing that explains *what* the host is being
 *   asked to look at.
 * - **Deciding the item and resolving the report are separate buttons.**
 *   Declining a photo is a moderation decision; "dismiss" says the host looked
 *   and disagreed. Collapsing them would mean a host who disagrees has no way to
 *   clear the flag, and the panel would never empty.
 */

export interface FlaggedPanelProps {
  readonly eventId: string;
  readonly items: readonly FlaggedItem[];
  readonly now: number;
  readonly busy: boolean;
  readonly onAct: (action: ModerationActionName, ids: readonly string[]) => void;
  readonly onShowAll: () => void;
}

export function FlaggedPanel({ items, now, busy, onAct, onShowAll }: FlaggedPanelProps) {
  const resolveReport = useMutation(backendApi.moderation.resolveReport);
  const [error, setError] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState<string | undefined>(undefined);

  const resolveAll = (
    mediaId: string,
    reports: readonly { readonly id: string }[],
    status: "actioned" | "dismissed",
  ): void => {
    setResolving(mediaId);
    setError(undefined);
    // Sequential rather than parallel: `resolveReport` re-derives whether the
    // item is still flagged on every call, and two of those racing inside one
    // Convex transaction window is a needless conflict retry.
    void (async () => {
      try {
        for (const report of reports) {
          await resolveReport({ reportId: report.id, status });
        }
      } catch (cause) {
        setError(appErrorMessage(cause));
      } finally {
        setResolving(undefined);
      }
    })();
  };

  return (
    <Card className="border-danger/40">
      <SectionHeading
        title="Reported by guests"
        description="Somebody at the party asked you to look at these."
        action={
          <Button variant="ghost" size="sm" onClick={onShowAll}>
            Filter the grid
          </Button>
        }
      />

      {error !== undefined ? (
        <p className="mt-3 text-sm text-danger" role="status" aria-live="polite">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {items.map(({ media, reports }) => {
          const open = reports.filter((report) => report.status === "open");
          return (
            <li
              key={media.id}
              className="flex flex-wrap gap-3 rounded-xl border border-line bg-raised/40 p-3 sm:flex-nowrap"
            >
              <div className="w-28 shrink-0">
                <MediaTile item={media} shape="square" />
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/12 px-2 py-0.5 text-xs font-medium text-danger">
                    <FlagIcon size={13} />
                    {formatReportCount(media.reportCount ?? reports.length)}
                  </span>
                  <span className="truncate text-xs text-muted">
                    from {media.uploaderDisplayName} ·{" "}
                    {formatRelative(media.uploadedAt ?? media.createdAt, now)}
                  </span>
                </div>

                <ul className="space-y-1">
                  {reports.slice(0, 3).map((report) => (
                    <li key={report.id} className="text-sm text-muted">
                      <span className="font-medium text-ink">
                        {REPORT_REASON_COPY[report.reason]}
                      </span>
                      {report.details === undefined ? null : (
                        <span className="text-muted"> — “{report.details}”</span>
                      )}
                      {report.status === "open" ? null : (
                        <span className="text-faint"> · {report.status}</span>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap gap-2 pt-0.5">
                  {canAct(media, "decline") ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        onAct("decline", [media.id]);
                      }}
                    >
                      Decline it
                    </Button>
                  ) : null}
                  {canAct(media, "revoke") ? (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        onAct("revoke", [media.id]);
                      }}
                    >
                      Take it down
                    </Button>
                  ) : null}
                  {canAct(media, "approve") ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        onAct("approve", [media.id]);
                      }}
                    >
                      Approve anyway
                    </Button>
                  ) : null}

                  {/*
                    One pair of buttons for the whole item, not one per report.
                    Three guests reporting the same photo is one thing to decide,
                    and three "Dismiss" buttons in a row is a host clicking the
                    same answer three times.
                  */}
                  {open.length > 0 ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={resolving === media.id}
                        onClick={() => {
                          resolveAll(media.id, open, "actioned");
                        }}
                      >
                        Mark handled
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={resolving === media.id}
                        onClick={() => {
                          resolveAll(media.id, open, "dismissed");
                        }}
                      >
                        Dismiss
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
