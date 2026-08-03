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

import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ReportReason } from "@partybooth/contracts/media";
import { SIGNED_READ_URL_TTL_SECONDS } from "@partybooth/contracts/storage";

import {
  DurationBadge,
  VideoPoster,
  playableVideoUri,
  usablePosterUri,
} from "@/components/media-video";
import { MediaViewer, type MediaViewerItem } from "@/components/media-viewer";
import { ItemActionsMenu, ReportSheet, type ReportTarget } from "@/components/report-sheet";
import {
  Button,
  EmptyState,
  Loading,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { appConfig } from "@/env";
import { useNow } from "@/hooks/use-now";
import { useSignedUrlRefreshKey } from "@/hooks/use-signed-url-refresh";
import { api, type EventSummary, type MediaItem } from "@/lib/api";
import { describeError } from "@/lib/errors";
import {
  formatBytes,
  isUrlUsable,
  mergeMediaTimeline,
  usableMediaUri,
  usableUploaderAvatarUri,
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
    <Screen>
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
          <MyMediaGrid
            entries={mergeMediaTimeline([], items)}
            onRetry={queue.retry}
            onCancel={queue.cancel}
            onWithdraw={null}
            workingMediaId={null}
          />
        )}
      </View>
    );
  }

  return <MyMediaLive event={event} items={items} />;
}

function MyMediaLive({ event, items }: { event: EventSummary; items: readonly QueueItem[] }) {
  const queue = useUploadQueue();
  const urlRefreshKey = useSignedUrlRefreshKey(SIGNED_READ_URL_TTL_SECONDS);
  const media = useQuery(api.media.myMedia, { eventId: event.id, urlRefreshKey });
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
        throw caught;
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
        <MyMediaGrid
          entries={entries}
          onRetry={queue.retry}
          onCancel={queue.cancel}
          onWithdraw={onWithdraw}
          workingMediaId={working}
        />
      )}
    </View>
  );
}

/**
 * My media as a compact contact sheet.
 *
 * Status lives on the thumbnail and details/actions move into the full-screen
 * viewer. That keeps ten captures visible in roughly the space the old cards
 * used for three, without hiding retry, cancel or withdrawal.
 */
function MyMediaGrid({
  entries,
  onRetry,
  onCancel,
  onWithdraw,
  workingMediaId,
}: {
  entries: readonly MediaTimelineEntry[];
  onRetry: (captureId: string) => void;
  onCancel: (captureId: string) => void;
  /** `null` in a build with no backend, where withdrawal cannot be performed. */
  onWithdraw: ((mediaId: string) => Promise<void>) | null;
  workingMediaId: string | null;
}) {
  const now = useNow();
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<MediaTimelineEntry | null>(null);
  const viewerItems = entries.map((entry) => viewerItemForTimeline(entry, now));
  const entryByKey = new Map(entries.map((entry) => [entry.captureId, entry]));

  const requestWithdraw = (entry: MediaTimelineEntry) => {
    setViewerKey(null);
    setWithdrawTarget(entry);
  };

  const confirmWithdraw = async () => {
    const mediaId = withdrawTarget?.media?.id;
    if (mediaId === undefined || onWithdraw === null) return;
    try {
      await onWithdraw(mediaId);
      setWithdrawTarget(null);
    } catch {
      // The parent owns the visible error message. Keep the confirmation open
      // so a failed request never looks like a successful withdrawal.
    }
  };

  return (
    <>
      <View style={styles.grid}>
        {entries.map((entry) => (
          <MyMediaTile
            key={entry.captureId}
            entry={entry}
            onOpen={() => setViewerKey(entry.captureId)}
            onRetry={() => onRetry(entry.captureId)}
            onCancel={() => onCancel(entry.captureId)}
            onWithdraw={
              entry.canWithdraw && onWithdraw !== null ? () => requestWithdraw(entry) : undefined
            }
          />
        ))}
      </View>

      <MediaViewer
        items={viewerItems}
        selectedKey={viewerKey}
        onClose={() => setViewerKey(null)}
        onSelect={setViewerKey}
        renderActions={(item) => {
          const entry = entryByKey.get(item.key);
          if (entry === undefined) return null;
          return (
            <>
              {entry.canRetry ? (
                <Button
                  label="Try again"
                  icon="refresh-outline"
                  onPress={() => onRetry(entry.captureId)}
                />
              ) : null}
              {entry.canCancel ? (
                <Button
                  label="Cancel upload"
                  variant="secondary"
                  icon="close-outline"
                  onPress={() => onCancel(entry.captureId)}
                />
              ) : null}
              {entry.canWithdraw && onWithdraw !== null ? (
                <Button
                  label="Withdraw"
                  variant="danger"
                  icon="arrow-undo-outline"
                  accessibilityHint="Asks you to confirm. Withdrawing deletes the item permanently."
                  onPress={() => requestWithdraw(entry)}
                />
              ) : null}
            </>
          );
        }}
      />

      <WithdrawSheet
        target={withdrawTarget === null ? null : labelForTimeline(withdrawTarget)}
        busy={workingMediaId === withdrawTarget?.media?.id}
        onConfirm={() => void confirmWithdraw()}
        onClose={() => setWithdrawTarget(null)}
      />
    </>
  );
}

function MyMediaTile({
  entry,
  onOpen,
  onRetry,
  onCancel,
  onWithdraw,
}: {
  entry: MediaTimelineEntry;
  onOpen: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onWithdraw: (() => void) | undefined;
}) {
  const isVideo = mediaTypeForTimeline(entry) === "video";
  const label = `${isVideo ? "Video" : "Photo"} — ${entry.status.label}`;
  const quickAction = entry.canRetry
    ? { label: "Try upload again", icon: "refresh-outline" as const, onPress: onRetry }
    : entry.canCancel
      ? { label: "Cancel upload", icon: "close-outline" as const, onPress: onCancel }
      : onWithdraw === undefined
        ? null
        : { label: "Withdraw", icon: "arrow-undo-outline" as const, onPress: onWithdraw };

  return (
    <View style={styles.tile}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View ${label.toLowerCase()}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.tilePressable, pressed && styles.tilePressed]}
      >
        <Thumb uri={entry.thumbnailUri} label={label} size="fill" />
        {isVideo ? (
          <DurationBadge seconds={entry.item?.durationSeconds ?? entry.media?.durationSeconds} />
        ) : null}
        <View style={styles.mediaStatus} pointerEvents="none">
          <View
            style={[styles.mediaStatusDot, { backgroundColor: TONE_COLORS[entry.status.tone] }]}
          />
          <Text style={styles.mediaStatusLabel}>{entry.status.label}</Text>
        </View>
        {entry.progress === undefined ? null : (
          <View style={styles.tileProgress}>
            <ProgressBar value={entry.progress} label="Upload progress" />
          </View>
        )}
      </Pressable>

      {quickAction === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={quickAction.label}
          onPress={quickAction.onPress}
          hitSlop={8}
          style={({ pressed }) => [styles.tileAction, pressed && styles.tilePressed]}
        >
          <Ionicons name={quickAction.icon} size={15} color={colors.text} />
        </Pressable>
      )}
    </View>
  );
}

function mediaTypeForTimeline(entry: MediaTimelineEntry): "photo" | "video" {
  return entry.item?.mediaType ?? entry.media?.mediaType ?? "photo";
}

function labelForTimeline(entry: MediaTimelineEntry): "photo" | "video" {
  return mediaTypeForTimeline(entry);
}

function bestFullImageUri(media: MediaItem, now: number): string | undefined {
  if (media.url !== undefined && isUrlUsable(media.urlExpiresAt, now)) return media.url;
  return usableMediaUri(media, now);
}

function viewerItemForTimeline(entry: MediaTimelineEntry, now: number): MediaViewerItem {
  const mediaType = mediaTypeForTimeline(entry);
  const media = entry.media;
  const item = entry.item;
  const remoteImage =
    media === undefined
      ? undefined
      : mediaType === "video"
        ? usablePosterUri(media, now)
        : bestFullImageUri(media, now);
  const remoteVideo = media === undefined ? undefined : playableVideoUri(media, now);
  const localVideoPoster =
    item === undefined || item.previewUri === item.uri ? undefined : item.previewUri;
  const detail = [
    entry.message,
    entry.status.detail.length === 0 ? undefined : entry.status.detail,
    media === undefined ? undefined : formatBytes(media.byteSize),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");

  return {
    key: entry.captureId,
    mediaType,
    imageUri:
      mediaType === "video"
        ? (remoteImage ?? localVideoPoster)
        : (remoteImage ?? item?.uri ?? entry.thumbnailUri),
    ...(mediaType === "video"
      ? {
          videoUri: remoteVideo ?? item?.uri,
        }
      : {}),
    title: `Your ${mediaType}`,
    ...(detail.length === 0 ? {} : { subtitle: detail }),
    status: { label: entry.status.label, color: TONE_COLORS[entry.status.tone] },
  };
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
  const urlRefreshKey = useSignedUrlRefreshKey(SIGNED_READ_URL_TTL_SECONDS);
  const media = useQuery(api.media.eventMedia, {
    eventId: event.id,
    states: ["approved"],
    urlRefreshKey,
  });
  // One clock for the whole grid, ticking rather than read during render, so
  // every tile agrees about which signed URLs have expired (ADR 0004 §5).
  const now = useNow();

  const report = useMutation(api.moderation.report);
  const block = useMutation(api.blocks.block);
  const withdraw = useMutation(api.media.withdraw);

  /** Which item's menu is open, and which item is being reported. */
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<ReportTarget | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<MediaItem | null>(null);
  const [withdrawWorking, setWithdrawWorking] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);

  const onReport = useCallback(
    async (input: { mediaId: string; reason: ReportReason; details?: string }): Promise<void> => {
      await report(input);
    },
    [report],
  );

  const onBlock = useCallback(
    async (userId: string): Promise<void> => {
      await block({ eventId: event.id, userId });
    },
    [block, event.id],
  );

  const onWithdraw = useCallback(async (): Promise<void> => {
    const target = withdrawTarget;
    if (target === null) return;
    setWithdrawWorking(true);
    setWithdrawError(null);
    try {
      await withdraw({ mediaId: target.id });
      setWithdrawTarget(null);
    } catch (caught) {
      captureHandledError(caught, { scope: "photos.galleryWithdraw" });
      setWithdrawError(describeError(caught).message);
    } finally {
      setWithdrawWorking(false);
    }
  }, [withdraw, withdrawTarget]);

  /**
   * Block straight from the menu, without a report first.
   *
   * Both routes have to exist. App Review looks for blocking as its own control,
   * and a guest who simply does not want to see somebody's photographs has done
   * nothing that warrants filing a complaint about them.
   */
  const onBlockFromMenu = useCallback(() => {
    const target = menuTarget;
    if (target === null) return;
    setMenuTarget(null);
    setBlockError(null);
    void (async () => {
      try {
        await onBlock(target.uploaderUserId);
      } catch (caught) {
        captureHandledError(caught, { scope: "photos.block" });
        setBlockError(describeError(caught).message);
      }
    })();
  }, [menuTarget, onBlock]);

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

  const viewerItems = media.map((item) => viewerItemForGallery(item, now));

  return (
    <>
      {blockError !== null || withdrawError !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{blockError ?? withdrawError}</MutedText>
        </Notice>
      ) : null}

      <View style={styles.grid}>
        {media.map((item) => (
          <GalleryTile
            key={item.id}
            item={item}
            now={now}
            onOpen={() => setViewerKey(item.id)}
            onMenu={item.isOwn ? undefined : () => setMenuTarget(targetFor(item))}
            onWithdraw={
              item.isOwn
                ? () => {
                    setWithdrawError(null);
                    setWithdrawTarget(item);
                  }
                : undefined
            }
          />
        ))}
      </View>

      <MediaViewer
        items={viewerItems}
        selectedKey={viewerKey}
        onClose={() => setViewerKey(null)}
        onSelect={setViewerKey}
        renderActions={(viewerItem) => {
          const item = media.find((candidate) => candidate.id === viewerItem.key);
          if (item === undefined) return null;
          return item.isOwn ? (
            <Button
              label="Withdraw"
              variant="danger"
              icon="arrow-undo-outline"
              accessibilityHint="Asks you to confirm. Withdrawing deletes the item permanently."
              onPress={() => {
                setViewerKey(null);
                setWithdrawError(null);
                setWithdrawTarget(item);
              }}
            />
          ) : (
            <Button
              label="Report or block"
              variant="secondary"
              icon="ellipsis-horizontal"
              onPress={() => {
                setViewerKey(null);
                setMenuTarget(targetFor(item));
              }}
            />
          );
        }}
      />

      <WithdrawSheet
        target={withdrawTarget?.mediaType ?? null}
        busy={withdrawWorking}
        onConfirm={() => void onWithdraw()}
        onClose={() => setWithdrawTarget(null)}
      />

      <ItemActionsMenu
        target={menuTarget}
        onReport={() => {
          setReportTarget(menuTarget);
          setMenuTarget(null);
        }}
        onBlock={onBlockFromMenu}
        onClose={() => setMenuTarget(null)}
      />

      <ReportSheet
        target={reportTarget}
        onReport={onReport}
        onBlock={onBlock}
        onClose={() => setReportTarget(null)}
      />
    </>
  );
}

/** The three facts the report and block flows need about an item. */
function targetFor(item: MediaItem): ReportTarget {
  return {
    mediaId: item.id,
    uploaderUserId: item.uploaderUserId,
    uploaderDisplayName: item.uploaderDisplayName,
    isOwn: item.isOwn,
  };
}

function GalleryTile({
  item,
  now,
  onOpen,
  onMenu,
  onWithdraw,
}: {
  item: MediaItem;
  now: number;
  onOpen: () => void;
  /** `undefined` on your own item — there is nothing to report or block. */
  onMenu: (() => void) | undefined;
  /** Present on your own item as the quick action in the tile corner. */
  onWithdraw: (() => void) | undefined;
}) {
  const label = `${item.mediaType === "video" ? "Video" : "Photo"} from ${item.uploaderDisplayName}`;

  if (item.mediaType === "video") {
    return (
      <Pressable
        style={styles.tile}
        onLongPress={onMenu ?? onWithdraw}
        // Long enough that scrolling a grid does not open menus by accident.
        delayLongPress={400}
        accessibilityLabel={label}
        // The tile is not itself a button — the poster inside it is. This
        // wrapper exists for the long-press, so it must not claim a role.
        accessibilityRole={onMenu === undefined ? undefined : "none"}
      >
        <VideoPoster
          posterUri={usablePosterUri(item, now)}
          durationSeconds={item.durationSeconds}
          label={label}
          onPlay={onOpen}
          fill
        />
        <UploaderBadge item={item} now={now} />
        {onMenu === undefined ? null : <ReportDot label={label} onPress={onMenu} />}
        {onWithdraw === undefined ? null : <WithdrawDot label={label} onPress={onWithdraw} />}
      </Pressable>
    );
  }

  return (
    <Pressable
      style={styles.tile}
      onPress={onOpen}
      onLongPress={onMenu ?? onWithdraw}
      delayLongPress={400}
      accessibilityLabel={`View ${label}`}
      accessibilityRole="button"
    >
      <Thumb uri={usableMediaUri(item, now)} label={label} size="fill" />
      <UploaderBadge item={item} now={now} />
      {onMenu === undefined ? null : <ReportDot label={label} onPress={onMenu} />}
      {onWithdraw === undefined ? null : <WithdrawDot label={label} onPress={onWithdraw} />}
    </Pressable>
  );
}

/** Visible attribution promised during onboarding, compact enough for a 3-up grid. */
function UploaderBadge({ item, now }: { item: MediaItem; now: number }) {
  const avatarUri = usableUploaderAvatarUri(item, now);
  return (
    <View style={styles.uploaderBadge} pointerEvents="none">
      <View style={styles.uploaderAvatar}>
        {avatarUri === undefined ? (
          <Text style={styles.uploaderInitial}>
            {(item.uploaderDisplayName[0] ?? "?").toUpperCase()}
          </Text>
        ) : (
          <Image
            source={{ uri: avatarUri }}
            style={styles.uploaderAvatarImage}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        )}
      </View>
      <Text style={styles.uploaderName} numberOfLines={1}>
        {item.uploaderDisplayName}
      </Text>
    </View>
  );
}

/**
 * The always-visible "…" in the corner of a tile.
 *
 * A long-press alone would satisfy the letter of Guideline 1.2 and fail its
 * spirit twice over: a guest never discovers it, and a reviewer with a checklist
 * and ninety seconds does not find it either. Small, low-contrast and out of the
 * way — but present, and reachable by a screen reader by name.
 */
function ReportDot({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Report or block — ${label}`}
      onPress={onPress}
      hitSlop={10}
      style={styles.reportDot}
    >
      <Ionicons name="ellipsis-horizontal" size={14} color={colors.text} />
    </Pressable>
  );
}

/** Owned media uses the same discoverable corner affordance, with the real action. */
function WithdrawDot({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Withdraw — ${label}`}
      accessibilityHint="Asks you to confirm before permanently deleting it."
      onPress={onPress}
      hitSlop={10}
      style={styles.reportDot}
    >
      <Ionicons name="arrow-undo-outline" size={14} color={colors.text} />
    </Pressable>
  );
}

function viewerItemForGallery(item: MediaItem, now: number): MediaViewerItem {
  const noun = item.mediaType === "video" ? "Video" : "Photo";
  return {
    key: item.id,
    mediaType: item.mediaType,
    imageUri: item.mediaType === "video" ? usablePosterUri(item, now) : bestFullImageUri(item, now),
    ...(item.mediaType === "video" ? { videoUri: playableVideoUri(item, now) } : {}),
    title: item.isOwn ? `Your ${noun.toLowerCase()}` : `${noun} by ${item.uploaderDisplayName}`,
    subtitle: `${formatBytes(item.byteSize)} · Approved in the event gallery`,
    ...(item.isOwn ? { status: { label: "Yours", color: colors.accent } } : {}),
  };
}

/**
 * Permanent withdrawal confirmation, shared by My media and Event gallery.
 *
 * It is a sheet rather than an expanding card so the compact grid does not jump
 * around, and because the destructive consequence deserves one focused choice.
 */
function WithdrawSheet({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: "photo" | "video" | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const noun = target ?? "item";
  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      transparent
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={busy ? () => undefined : onClose}
    >
      <View style={styles.withdrawBackdrop}>
        <View style={styles.withdrawSheet}>
          <View style={styles.withdrawIcon}>
            <Ionicons name="arrow-undo-outline" size={22} color={colors.danger} />
          </View>
          <View style={styles.withdrawCopy}>
            <Text style={styles.withdrawTitle}>Withdraw this {noun}?</Text>
            <Text style={styles.withdrawBody}>
              It will be deleted permanently. The host and gallery lose it too, and it cannot be
              sent again.
            </Text>
          </View>
          <View style={styles.actions}>
            <Button label="Withdraw permanently" variant="danger" busy={busy} onPress={onConfirm} />
            <Button label="Keep it" variant="secondary" disabled={busy} onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumb: { borderRadius: radius.sm, backgroundColor: colors.surfaceRaised },
  thumbFill: { width: "100%", aspectRatio: 1 },
  track: { height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised },
  fill: { height: 4, borderRadius: radius.pill, backgroundColor: colors.accent },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tilePressable: { position: "relative", overflow: "hidden", borderRadius: radius.sm },
  tilePressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  tileAction: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.xs,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  mediaStatus: {
    position: "absolute",
    left: spacing.xs,
    bottom: spacing.xs,
    maxWidth: "76%",
    minHeight: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.78)",
  },
  mediaStatusDot: { width: 6, height: 6, borderRadius: radius.pill },
  mediaStatusLabel: {
    ...typography.caption,
    color: colors.text,
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  tileProgress: { position: "absolute", left: 0, right: 0, bottom: 0 },
  reportDot: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.xs,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.62)",
  },
  uploaderBadge: {
    position: "absolute",
    left: spacing.xs,
    right: spacing.xs,
    bottom: spacing.xs,
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.72)",
  },
  uploaderAvatar: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
  },
  uploaderAvatarImage: { width: "100%", height: "100%" },
  uploaderInitial: { ...typography.caption, fontSize: 10, color: colors.accent },
  uploaderName: { ...typography.caption, flex: 1, color: colors.text, fontSize: 10 },
  withdrawBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    padding: spacing.md,
    backgroundColor: "rgba(12, 6, 17, 0.72)",
  },
  withdrawSheet: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  withdrawIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  withdrawCopy: { flex: 1, minWidth: 220, gap: spacing.xs },
  withdrawTitle: { ...typography.heading, color: colors.text },
  withdrawBody: { ...typography.body, color: colors.textMuted, lineHeight: 21 },
  // Three across on a phone, with the gap taken out of each column. `gap` on a
  // wrapping row does not subtract from a percentage basis, so the width does.
  tile: { position: "relative", width: "31.5%", borderRadius: radius.sm },
});
