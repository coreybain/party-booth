"use client";

import { useQuery } from "convex/react";
import Link from "next/link";

import { Card, Placeholder, SectionHeading } from "@/components/layout/card";
import { MediaTile } from "@/components/media/media-tile";
import { Button } from "@/components/ui/button";
import { backendApi } from "@/lib/convex-api";
import { formatBytes } from "@/lib/media-view";

/**
 * The "live home" numbers: pending count, totals, contributors, storage, and a
 * strip of what just arrived.
 *
 * PLAN.md → "Live home: code/QR, status, pending count, recent submissions,
 * totals". The code and QR are `InvitePanel`'s and stay exactly where they were;
 * this is everything else.
 *
 * **Two queries, deliberately.** `stats.overview` returns numbers and nothing
 * else, so a global admin may read it; `stats.recentSubmissions` returns
 * thumbnails, which means signed URLs, which means hosts only — PLAN.md is
 * explicit that admins never look at guests' photos. Collapsing them into one
 * query would collapse that distinction, and the place a distinction like that
 * dies is a convenience refactor.
 *
 * The pending count is a **link**, because it is the only number on this page
 * that implies an action.
 */

export function EventStats({
  eventId,
  isHost,
}: {
  readonly eventId: string;
  readonly isHost: boolean;
}) {
  const overview = useQuery(backendApi.stats.overview, { eventId });

  if (overview === undefined) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="text-sm text-muted" role="status">
            Counting…
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted" role="status">
            Counting…
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <SectionHeading
            title="Waiting for you"
            description="Everything a guest has sent that nobody has decided on."
            action={
              <Link href="/media">
                <Button size="sm" variant={overview.pending > 0 ? "primary" : "secondary"}>
                  Moderate
                </Button>
              </Link>
            }
          />
          <div className="mt-4 flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums text-ink">{overview.pending}</span>
            <span className="text-sm text-muted">
              {overview.pending === 1 ? "submission" : "submissions"} pending
            </span>
          </div>
          {overview.flagged > 0 ? (
            <p className="mt-2 text-sm text-danger">
              {overview.flagged} reported by guests — those are at the top of the queue.
            </p>
          ) : null}
          {overview.processing > 0 ? (
            <p className="mt-2 text-sm text-faint">
              {overview.processing} still arriving. They are not counted above until they land.
            </p>
          ) : null}
        </Card>

        <Card>
          <SectionHeading title="The party so far" description="Everything, in numbers." />
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Approved" value={overview.approved} />
            <Stat label="Declined" value={overview.declined} />
            <Stat label="Photos" value={overview.byType.photo} />
            <Stat label="Videos" value={overview.byType.video} />
            <Stat label="Contributors" value={overview.contributorCount} />
            <Stat label="Storage" text={formatBytes(overview.storageBytes)} />
          </dl>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        {isHost ? <RecentSubmissions eventId={eventId} /> : null}

        <Card>
          <SectionHeading
            title="Most active"
            description="By how much of theirs you have approved."
          />
          {overview.topContributors.length === 0 ? (
            <Placeholder className="mt-4" title="Nobody yet" />
          ) : (
            <ol className="mt-4 space-y-2">
              {overview.topContributors.map((person, index) => (
                <li key={person.userId} className="flex items-baseline gap-3 text-sm">
                  <span className="w-4 shrink-0 text-right text-faint tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink" title={person.displayName}>
                    {person.displayName}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {person.approved}
                    <span className="text-faint">/{person.total}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  text,
}: {
  readonly label: string;
  readonly value?: number;
  readonly text?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-faint">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-ink">{text ?? value ?? 0}</dd>
    </div>
  );
}

/**
 * The newest submissions, thumbnails and all.
 *
 * Host-only by construction: `stats.recentSubmissions` is the query that mints
 * signed URLs, and it is not rendered at all for a viewer who is not a host —
 * which is belt and braces, because Convex refuses it for them anyway.
 */
function RecentSubmissions({ eventId }: { readonly eventId: string }) {
  const recent = useQuery(backendApi.stats.recentSubmissions, { eventId });

  return (
    <Card>
      <SectionHeading
        title="Just arrived"
        description="Live, as guests send them."
        action={
          <Link href="/media">
            <Button size="sm" variant="ghost">
              See all
            </Button>
          </Link>
        }
      />

      {recent === undefined ? (
        <p className="mt-4 text-sm text-muted" role="status">
          Loading…
        </p>
      ) : recent.length === 0 ? (
        <Placeholder className="mt-4" title="No media yet">
          Guests who have joined can add photos and video as soon as the event is live.
        </Placeholder>
      ) : (
        <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {recent.map((entry) => (
            <li key={entry.media.id}>
              <MediaTile item={entry.media} shape="square" playable={false} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
