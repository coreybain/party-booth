/**
 * Photos tab — "My media" and the approved "Event gallery".
 *
 * The native twin of `apps/web`'s `<MyMedia>` and `<EventMediaList>`, and
 * deliberately the same behaviour: the same status words, the same merge of the
 * local queue with the server's rows, the same two-tap permanent withdrawal.
 * A guest who took a photo in the app and then opens the party in mobile web
 * must not be told two different stories about it.
 *
 * ## The two lists are different questions
 *
 * - **My media** is `media.myMedia` (a live Convex subscription) merged with the
 *   local upload queue on `captureId` — see `src/lib/media-view.ts`. A photo
 *   exists in both places for a few seconds and must appear once: the local row
 *   has the thumbnail, the progress and the retry, the server row has the
 *   moderation state. Merging is what lets both be true.
 * - **Event gallery** is `media.eventMedia` restricted to `approved`. The
 *   restriction is a *filter*, not a permission — `canSeeMedia` in Convex is
 *   what decides visibility, and this query cannot widen it. Asking for
 *   `approved` only keeps a guest's own `pending` photo out of the party-wide
 *   grid, where it does not belong until a host says so.
 *
 * Both are reactive, so a host approving on their laptop flips a chip and lands
 * a tile here with no pull-to-refresh.
 *
 * ## Convex hooks live below the configuration gate
 *
 * An unconfigured build mounts no `ConvexProvider`, and `useQuery` under no
 * provider throws during render. Every Convex call is therefore inside a
 * `*Live` component that is only reached once `appConfig.status === "ready"`
 * and an active event exists — the same shape `app/join/[token].tsx` uses.
 */

import { useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { appConfig } from "@/env";
import { useNow } from "@/hooks/use-now";
import { api, type EventSummary, type MediaItem } from "@/lib/api";
import { describeError } from "@/lib/errors";
import {
  formatBytes,
  mergeMediaTimeline,
  usableMediaUri,
  type MediaTimelineEntry,
  type MediaTone,
} from "@/lib/media-view";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { useUploadQueue } from "@/upload/queue-provider";
import { colors, radius, spacing, typography } from "@/theme";

import type { QueueItem } from "@/upload/types";

const SEGMENTS = [
  { key: "mine", label: "My media" },
  { key: "event", label: "Event gallery" },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]["key"];

/** Chip colours, one per tone in `media-view`. */
const TONE_COLORS: Record<MediaTone, string> = {
  neutral: colors.textFaint,
  positive: colors.success,
  warning: colors.warning,
  danger: colors.danger,
  progress: colors.accentSoft,
};

export default function PhotosScreen() {
  const [segment, setSegment] = useState<SegmentKey>("mine");
  const { activeEvent, eventsLoading } = useSession();

  return (
    // The tab shell renders the header and owns the notch; see `(tabs)/_layout.tsx`.
    <Screen edges={["left", "right"]}>
      {/* Both lists are per-event, so the subtitle names the one they belong to —
          otherwise switching parties silently changes what "my media" means. */}
      <ScreenHeader title="Photos" subtitle={activeEvent?.name} />

      <View style={styles.segmented} accessibilityRole="tablist">
        {SEGMENTS.map((item) => {
          const active = item.key === segment;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setSegment(item.key)}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {segment === "mine" ? (
          <MyMedia event={activeEvent} eventsLoading={eventsLoading} />
        ) : (
          <EventGallery event={activeEvent} eventsLoading={eventsLoading} />
        )}
      </ScrollView>
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* My media                                                                   */
/* -------------------------------------------------------------------------- */

function MyMedia({ event, eventsLoading }: { event: EventSummary | null; eventsLoading: boolean }) {
  const queue = useUploadQueue();
  const items = queue.itemsFor(event?.id);

  if (event === null) {
    if (eventsLoading) return <Loading label="Finding your parties…" />;
    return (
      <EmptyState
        icon="qr-code-outline"
        title="Join a party first"
        body="Anything you capture will show up here, with what the host has done with it."
      />
    );
  }

  // No backend: the queue still holds captures, and saying so beats an empty
  // list that looks like the photos were lost.
  if (appConfig.status === "unconfigured") {
    return (
      <View style={styles.list}>
        <Notice tone="warning" title="Nothing can be sent from this build">
          <MutedText>
            There is no backend configured, so these are on this phone only and have no moderation
            status yet.
          </MutedText>
        </Notice>
        {items.length === 0 ? (
          <EmptyState
            icon="cloud-upload-outline"
            title="Nothing captured yet"
            body="Photos you take on the Camera tab are kept here until there is somewhere to send them."
          />
        ) : (
          mergeMediaTimeline([], items).map((entry) => (
            <TimelineRow
              key={entry.captureId}
              entry={entry}
              onRetry={queue.retry}
              onCancel={queue.cancel}
              onWithdraw={null}
            />
          ))
        )}
      </View>
    );
  }

  return <MyMediaLive event={event} items={items} />;
}

function MyMediaLive({ event, items }: { event: EventSummary; items: readonly QueueItem[] }) {
  const queue = useUploadQueue();
  const media = useQuery(api.media.myMedia, { eventId: event.id });
  const withdraw = useMutation(api.media.withdraw);

  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onWithdraw = useCallback(
    async (mediaId: string): Promise<void> => {
      setWorking(mediaId);
      setError(null);
      try {
        await withdraw({ mediaId });
      } catch (caught) {
        captureHandledError(caught, { scope: "photos.withdraw" });
        setError(describeError(caught).message);
      } finally {
        setWorking(null);
      }
    },
    [withdraw],
  );

  const entries = mergeMediaTimeline(media ?? [], items);

  // `undefined` is "the subscription has not answered yet". Showing the empty
  // state during that beat tells a guest their photos are gone.
  if (media === undefined && entries.length === 0) return <Loading label="Loading your photos…" />;

  return (
    <View style={styles.list}>
      {error !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          icon="cloud-upload-outline"
          title="Nothing sent yet"
          body="Everything you capture shows up here with its moderation status. You can retry a failed upload, or withdraw something you'd rather the host didn't see."
        />
      ) : (
        entries.map((entry) => (
          <TimelineRow
            key={entry.captureId}
            entry={entry}
            onRetry={queue.retry}
            onCancel={queue.cancel}
            onWithdraw={onWithdraw}
            working={working === entry.media?.id}
          />
        ))
      )}
    </View>
  );
}

/**
 * One row of "My media".
 *
 * Withdrawal is two taps and the second one says what it means. `media.withdraw`
 * is **permanent** (ADR 0004 §6): the row goes to `deleted`, every unspent grant
 * for the capture is expired so an upload still in flight cannot complete, and
 * the object is purged from storage — which kills every signed URL ever issued
 * for it, whatever its expiry said. None of that can be undone, so the
 * confirmation says so in those words rather than "Are you sure?".
 *
 * The row then vanishes on its own, because `canSeeMedia` excludes `deleted`
 * for everybody including its submitter. That is the correct feedback and it
 * needs no toast.
 */
function TimelineRow({
  entry,
  onRetry,
  onCancel,
  onWithdraw,
  working = false,
}: {
  entry: MediaTimelineEntry;
  onRetry: (captureId: string) => void;
  onCancel: (captureId: string) => void;
  /** `null` in a build with no backend, where withdrawal cannot be performed. */
  onWithdraw: ((mediaId: string) => Promise<void>) | null;
  working?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const mediaId = entry.media?.id;
  const canWithdraw = entry.canWithdraw && mediaId !== undefined && onWithdraw !== null;

  return (
    <Card>
      <View style={styles.row}>
        <Thumb uri={entry.thumbnailUri} label="Your photo" size={64} />

        <View style={styles.rowBody}>
          <Badge label={entry.status.label} tone={TONE_COLORS[entry.status.tone]} />
          {entry.status.detail.length > 0 ? <MutedText>{entry.status.detail}</MutedText> : null}

          {entry.progress !== undefined ? (
            <ProgressBar value={entry.progress} label="Upload progress" />
          ) : null}

          {entry.message !== undefined ? (
            <Text style={styles.failure} accessibilityLiveRegion="polite">
              {entry.message}
            </Text>
          ) : null}

          {entry.media !== undefined ? (
            <Text style={styles.meta}>{formatBytes(entry.media.byteSize)}</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.actions}>
        {entry.canRetry ? (
          <Button
            label="Try again"
            icon="refresh-outline"
            onPress={() => onRetry(entry.captureId)}
          />
        ) : null}

        {entry.canCancel ? (
          <Button
            label="Cancel"
            variant="secondary"
            icon="close-outline"
            onPress={() => onCancel(entry.captureId)}
          />
        ) : null}

        {canWithdraw && !confirming ? (
          <Button
            label="Take it back"
            variant="secondary"
            icon="arrow-undo-outline"
            accessibilityHint="Asks you to confirm. Withdrawing deletes the photo permanently."
            onPress={() => setConfirming(true)}
          />
        ) : null}
      </View>

      {canWithdraw && confirming ? (
        <Notice tone="danger" title="Take this photo back?">
          <MutedText>
            It is deleted for good — the host loses it too, and it cannot be sent again.
          </MutedText>
          <View style={styles.actions}>
            <Button
              label="Yes, delete it"
              variant="danger"
              busy={working}
              onPress={() => {
                void onWithdraw(mediaId);
              }}
            />
            <Button
              label="Keep it"
              variant="secondary"
              disabled={working}
              onPress={() => setConfirming(false)}
            />
          </View>
        </Notice>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Event gallery                                                              */
/* -------------------------------------------------------------------------- */

function EventGallery({
  event,
  eventsLoading,
}: {
  event: EventSummary | null;
  eventsLoading: boolean;
}) {
  if (event === null) {
    if (eventsLoading) return <Loading label="Finding your parties…" />;
    return (
      <EmptyState
        icon="images-outline"
        title="Join a party first"
        body="The gallery shows everything the host has approved at the party you're in."
      />
    );
  }

  if (appConfig.status === "unconfigured") {
    return (
      <EmptyState
        icon="images-outline"
        title="No gallery in this build"
        body="There is no backend configured, so there is nothing to subscribe to."
      />
    );
  }

  return <EventGalleryLive event={event} />;
}

function EventGalleryLive({ event }: { event: EventSummary }) {
  // `approved` only. The party-wide grid is not the place a guest's own pending
  // photo belongs — that is what "My media" is for — and `canSeeMedia` in Convex
  // would otherwise include it for its own submitter.
  const media = useQuery(api.media.eventMedia, { eventId: event.id, states: ["approved"] });
  // One clock for the whole grid, ticking rather than read during render, so
  // every tile agrees about which signed URLs have expired (ADR 0004 §5).
  const now = useNow();

  if (media === undefined) return <Loading label="Loading the gallery…" />;

  if (media.length === 0) {
    return (
      <EmptyState
        icon="images-outline"
        title="No approved media yet"
        body="Once the host approves submissions, the whole party's photos appear here — and update live as they land."
      />
    );
  }

  return (
    <View style={styles.grid}>
      {media.map((item) => (
        <GalleryTile key={item.id} item={item} now={now} />
      ))}
    </View>
  );
}

function GalleryTile({ item, now }: { item: MediaItem; now: number }) {
  return (
    <View style={styles.tile}>
      <Thumb
        uri={usableMediaUri(item, now)}
        label={`Photo from ${item.uploaderDisplayName}`}
        size="fill"
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A square thumbnail.
 *
 * `expo-image` rather than RN's `Image`: it has a real memory/disk cache and a
 * transition, both of which matter for a grid of short-lived signed URLs that
 * the subscription will hand back with a *different* signature the next time
 * anything about the row changes.
 *
 * `contentFit="cover"` with a fixed box means no layout shift when a URL 403s
 * on expiry — the placeholder is exactly the size the image was.
 */
function Thumb({
  uri,
  label,
  size,
}: {
  uri: string | undefined;
  label: string;
  size: number | "fill";
}) {
  const box = size === "fill" ? styles.thumbFill : { width: size, height: size };

  if (uri === undefined) {
    return <View style={[styles.thumb, box]} accessibilityLabel={`${label} — not available yet`} />;
  }

  return (
    <Image
      source={{ uri }}
      style={[styles.thumb, box]}
      contentFit="cover"
      transition={120}
      accessibilityLabel={label}
      accessibilityIgnoresInvertColors
    />
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ now: percent, min: 0, max: 100 }}
    >
      <View style={[styles.fill, { width: `${percent}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xs,
    gap: spacing.xs,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  segmentActive: { backgroundColor: colors.surfaceRaised },
  segmentLabel: { ...typography.label, color: colors.textFaint },
  segmentLabelActive: { color: colors.text },
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxl },
  list: { gap: spacing.md },
  row: { flexDirection: "row", gap: spacing.md },
  rowBody: { flex: 1, gap: spacing.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  failure: { ...typography.body, color: colors.danger },
  meta: { ...typography.caption, color: colors.textFaint },
  thumb: { borderRadius: radius.sm, backgroundColor: colors.surfaceRaised },
  thumbFill: { width: "100%", aspectRatio: 1 },
  track: { height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised },
  fill: { height: 4, borderRadius: radius.pill, backgroundColor: colors.accent },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  // Three across on a phone, with the gap taken out of each column. `gap` on a
  // wrapping row does not subtract from a percentage basis, so the width does.
  tile: { width: "31.5%" },
});
