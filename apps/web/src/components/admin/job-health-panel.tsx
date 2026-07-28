"use client";

import { useQuery } from "convex/react";

import { Card, SectionHeading } from "@/components/layout/card";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/cn";
import { adminApi, type AdminJobHealth } from "@/lib/convex-api";

/**
 * Job health: the background work that has gone wrong, and nothing else.
 *
 * PLAN.md puts "job-health dashboards" second on the cut list. It was not cut,
 * but it is deliberately the smallest thing that answers the only question this
 * panel is for at 1 a.m. on 5 August: *is anything stuck?* Every figure is a
 * count, every count has a "what to do" sentence attached when it is non-zero,
 * and a healthy deployment is one line of prose rather than a wall of zeroes.
 *
 * Two figures need explaining and both are explained on screen rather than only
 * here:
 *
 * - **Stuck purges** is the one that contradicts a promise. A media row with
 *   `deletedAt` set and no `storageDeletedAt` means a guest withdrew something,
 *   was told it was gone, and the bytes are still in the bucket.
 * - **Pending exports** is always zero at launch by construction — ZIP exports
 *   are P2 and there is no job table to count. It is shown anyway, marked, so
 *   nobody reads its absence as "the dashboard is broken".
 */
export function JobHealthPanel() {
  const health = useQuery(adminApi.jobHealth, {});

  return (
    <Card>
      <SectionHeading
        title="Job health"
        description="Background work that needs a person. A quiet panel is the correct panel."
      />

      {health === undefined ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-raised" aria-hidden="true" />
      ) : (
        <JobHealthFigures health={health} />
      )}
    </Card>
  );
}

interface HealthFigure {
  readonly label: string;
  readonly value: number;
  /** Shown when the value is non-zero. Absent means "non-zero is still fine". */
  readonly alarm?: string;
  readonly note?: string;
}

function JobHealthFigures({ health }: { readonly health: AdminJobHealth }) {
  const figures: readonly HealthFigure[] = [
    {
      label: "Stuck purges",
      value: health.stuckPurges,
      alarm:
        "Somebody was told their photo was deleted and the file is still in storage. Retry the purge before anything else on this page.",
    },
    {
      label: "Deletions overdue",
      value: health.deletionJobs.due,
      alarm: "The daily deletion cron has not run, or it is failing. Check the Convex logs.",
    },
    {
      label: "Deletions failed",
      value: health.deletionJobs.failed,
      alarm: "A purge raised and gave up. These do not retry themselves.",
    },
    { label: "Deletions scheduled", value: health.deletionJobs.scheduled },
    { label: "Deletions running", value: health.deletionJobs.running },
    {
      label: "Push queued",
      value: health.pushQueue.queued,
      note: "Queued notifications drain on the scheduler. A number that does not fall means Expo is unreachable — or unset, which is safe.",
    },
    {
      label: "Push failed",
      value: health.pushQueue.failed,
      alarm: "Expo refused these. Usually a bad project id rather than a bad token.",
    },
    {
      label: "Devices switched off",
      value: health.disabledPushDevices,
      note: "Tokens Expo reported as gone. Expected, and self-healing on the next app launch.",
    },
    {
      label: "Exports pending",
      value: health.pendingExports,
      note: "Always zero at launch — ZIP exports are post-launch (P2) and there is no job table to count.",
    },
  ];

  const alarming = figures.filter((figure) => figure.value > 0 && figure.alarm !== undefined);

  return (
    <div className="mt-4">
      {alarming.length === 0 ? (
        <Callout tone="success" live="polite">
          Nothing is stuck.
        </Callout>
      ) : (
        <div className="space-y-2">
          {alarming.map((figure) => (
            <Callout key={figure.label} tone="danger" live="polite">
              <p className="text-ink">
                {figure.label}: {figure.value}
              </p>
              <p className="mt-1">{figure.alarm}</p>
            </Callout>
          ))}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.label}>
            <dt className="text-sm text-faint">{figure.label}</dt>
            <dd
              className={cn(
                "text-lg font-semibold tabular-nums",
                figure.value > 0 && figure.alarm !== undefined ? "text-danger" : "text-ink",
              )}
            >
              {figure.value}
            </dd>
            {figure.note === undefined ? null : (
              <p className="mt-0.5 text-xs text-faint">{figure.note}</p>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}
