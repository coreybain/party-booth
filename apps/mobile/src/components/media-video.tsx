/**
 * Playing a clip back — the poster, the badge, and the player over the top.
 *
 * ## Why a poster and a tap, rather than an inline player
 *
 * A gallery grid at a party is twenty tiles, and twenty `VideoView`s is twenty
 * decoders. iOS gives an app roughly sixteen simultaneous `AVPlayer` instances
 * before it starts refusing them, and Android's are worse — the failure is a
 * black tile, not an exception, so it looks exactly like a broken upload. Every
 * tile is therefore a **still image** until somebody asks for the video, and
 * then exactly one player exists.
 *
 * ## Signed URLs
 *
 * The source is a permission-checked short-lived URL minted by `projectMedia`,
 * and `urlExpiresAt` says when to stop trusting it. A Convex query re-runs when
 * its *data* changes, not when the clock moves (ADR 0004 §5), so a gallery left
 * open in a pocket is holding URLs that expired minutes ago. `usableMediaUri`
 * and its poster twin drop an expired one, and the tile falls back to a
 * placeholder — a grey box beats a spinner that will never resolve.
 *
 * ## Muted
 *
 * `player.muted = true` on creation. A tap on a tile in a room full of people is
 * not consent to play sound out loud, and the slideshow on the organiser's TV is
 * muted for the same reason (PLAN.md → "photos + muted autoplay video"). The
 * control to unmute is in the native controls, where a guest expects it.
 */

import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { formatClipDuration } from "../lib/shutter";
import { colors, radius, spacing, typography } from "../theme";

import type { MediaItem } from "../lib/api";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Duration badge                                                             */
/* -------------------------------------------------------------------------- */

/**
 * "0:12" in the corner of a tile.
 *
 * Draws nothing at all for a photo, and nothing for a video whose duration never
 * made it onto the row — a badge reading "0:00" over a real clip is worse than
 * no badge, because it reads as a broken file rather than as missing metadata.
 */
export function DurationBadge({ seconds }: { seconds: number | undefined }) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  return (
    <View style={styles.badge} pointerEvents="none">
      <Ionicons name="play" size={10} color={colors.text} />
      <Text style={styles.badgeLabel}>{formatClipDuration(seconds)}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The poster tile                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A video, as it appears before anybody plays it.
 *
 * `posterUri` is the still; when there is none — a phone that died between the
 * clip and its poster — the tile is a plain dark box with the play glyph, which
 * is honest and still tappable. That case is exactly the one the backend's
 * "a missing derivative never strands a capture" rule exists to permit.
 */
export function VideoPoster({
  posterUri,
  durationSeconds,
  label,
  onPlay,
  fill = false,
}: {
  posterUri: string | undefined;
  durationSeconds: number | undefined;
  label: string;
  /** `undefined` when there is no playable URL — the tile stops being a button. */
  onPlay: (() => void) | undefined;
  fill?: boolean;
}) {
  const body = (
    <>
      {posterUri === undefined ? (
        <View style={[styles.poster, fill && styles.posterFill]} />
      ) : (
        <Image
          source={{ uri: posterUri }}
          style={[styles.poster, fill && styles.posterFill]}
          contentFit="cover"
          transition={120}
          accessibilityLabel={label}
          accessibilityIgnoresInvertColors
        />
      )}
      {onPlay === undefined ? null : (
        <View style={styles.playScrim} pointerEvents="none">
          <View style={styles.playGlyph}>
            <Ionicons name="play" size={18} color={colors.onAccent} />
          </View>
        </View>
      )}
      <DurationBadge seconds={durationSeconds} />
    </>
  );

  if (onPlay === undefined) {
    return (
      <View style={[styles.tile, fill && styles.tileFill]} accessibilityLabel={label}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Play ${label}`}
      onPress={onPlay}
      style={({ pressed }) => [styles.tile, fill && styles.tileFill, pressed && styles.tilePressed]}
    >
      {body}
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */
/* The player                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One clip, full screen, over whatever was underneath.
 *
 * A `Modal` rather than a route: the player is a moment, not a place. Backing out
 * of it must not pop the guest out of the gallery they were scrolling, and the
 * scroll position has to survive — a route push would lose it on Android's back
 * button, which is the one people actually use.
 *
 * This component is only ever rendered while the modal is **open**, so no native
 * player exists until a guest asks for one, and `useVideoPlayer` releases it on
 * unmount — which is what closing the modal does. That is the whole reason the
 * stage is a separate component rather than the modal's body: a hook cannot be
 * called conditionally, so the condition has to be which component is mounted.
 */
function VideoStage({ uri, onClose }: { uri: string; onClose: () => void }) {
  const player = useVideoPlayer({ uri }, (instance) => {
    // Muted, always. A tap in a crowded room is not consent to make noise.
    instance.muted = true;
    // Not looped: a clip that restarts for ever behind a person trying to find
    // the close button is a small hostage situation.
    instance.loop = false;
    instance.play();
  });

  return (
    <View style={styles.stage}>
      <VideoView
        player={player}
        style={styles.player}
        contentFit="contain"
        // The platform's own transport controls — scrub, mute, fullscreen. A
        // hand-rolled set would be one more thing to get wrong on two platforms
        // in launch week, and guests already know these.
        nativeControls
        allowsPictureInPicture={false}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close the video"
        onPress={onClose}
        hitSlop={12}
        style={styles.close}
      >
        <Ionicons name="close" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}

/**
 * The modal wrapper. Renders no player at all while it is shut.
 *
 * `visible={false}` on a `Modal` still mounts its children on Android, so the
 * source is checked here as well — `uri === null` renders nothing, and that is
 * what keeps a closed lightbox from holding a decoder.
 */
export function VideoLightbox({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  return (
    <Modal
      visible={uri !== null}
      animationType="fade"
      // Both orientations, matching the app: a clip recorded sideways should be
      // watchable sideways.
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={onClose}
      transparent={false}
      statusBarTranslucent
    >
      {uri === null ? <View style={styles.stage} /> : <VideoStage uri={uri} onClose={onClose} />}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* The hook a list uses                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "Which clip, if any, is playing" — one piece of state per list.
 *
 * Returned as a hook rather than left to each screen because both galleries and
 * "My media" need exactly this and getting it wrong in one of them (two open
 * lightboxes, or one that will not close) is not something a screenshot review
 * would catch.
 */
export function useVideoLightbox(): {
  playing: string | null;
  open: (uri: string) => void;
  close: () => void;
  lightbox: ReactNode;
} {
  const [playing, setPlaying] = useState<string | null>(null);
  const close = useCallback(() => setPlaying(null), []);
  const open = useCallback((uri: string) => setPlaying(uri), []);

  return {
    playing,
    open,
    close,
    lightbox: <VideoLightbox uri={playing} onClose={close} />,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a media row                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The best still-valid poster for a video row, at a given instant.
 *
 * Poster first, then the preview — a video's `previewKey` would be a downscaled
 * clip rather than an image if one existed, but `projectMedia` already falls back
 * `previewKey ?? posterKey`, so in practice both point at the poster today. The
 * order matters for the day a transcoder exists (PLAN.md → P2) and the preview
 * becomes a clip that `expo-image` cannot draw.
 */
export function usablePosterUri(media: MediaItem, now: number): string | undefined {
  if (media.posterUrl !== undefined && (media.posterUrlExpiresAt ?? Infinity) > now) {
    return media.posterUrl;
  }
  if (media.previewUrl !== undefined && (media.previewUrlExpiresAt ?? Infinity) > now) {
    return media.previewUrl;
  }
  return undefined;
}

/**
 * The URL to actually play, or `undefined` when there is nothing playable.
 *
 * Only the **original** is a video file. `previewUrl` is an image today (the
 * poster, via the server's fallback), so handing it to a player produces a
 * permanent spinner. `undefined` is the correct answer for a fellow guest whose
 * signed original URL has expired — and for one who is never served the original
 * at all, which `mayServeOriginal` decides, not this.
 */
export function playableVideoUri(media: MediaItem, now: number): string | undefined {
  if (media.mediaType !== "video") return undefined;
  if (media.url === undefined) return undefined;
  if ((media.urlExpiresAt ?? Infinity) <= now) return undefined;
  return media.url;
}

const styles = StyleSheet.create({
  tile: { position: "relative", borderRadius: radius.sm, overflow: "hidden" },
  tileFill: { width: "100%", aspectRatio: 1 },
  tilePressed: { opacity: 0.8 },
  poster: { width: "100%", height: "100%", backgroundColor: colors.surfaceRaised },
  posterFill: { width: "100%", aspectRatio: 1 },
  playScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  playGlyph: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    // Nudged so the glyph's optical centre lands on the button's geometric one:
    // a triangle's centre of mass is left of its bounding box.
    paddingLeft: 3,
  },
  badge: {
    position: "absolute",
    right: spacing.xs,
    bottom: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: "rgba(18, 9, 27, 0.78)",
  },
  badgeLabel: { ...typography.caption, fontWeight: "700", color: colors.text },
  stage: { flex: 1, backgroundColor: "#000" },
  player: { flex: 1, width: "100%" },
  close: {
    position: "absolute",
    top: spacing.xxl,
    right: spacing.lg,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(18, 9, 27, 0.7)",
  },
});
