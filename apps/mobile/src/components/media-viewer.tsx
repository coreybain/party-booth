/**
 * A single full-screen viewer for photographs and clips.
 *
 * Both Photos-tab segments feed this component. Keeping one viewer matters more
 * than sharing some styles: a guest should learn one gesture (tap, then swipe)
 * and get the same close, position and action controls whether an item came
 * from My media or the event gallery.
 */

import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, radius, spacing, typography } from "../theme";

import type { MediaType } from "@partybooth/contracts/media";
import type { ReactNode } from "react";

export interface MediaViewerItem {
  readonly key: string;
  readonly mediaType: MediaType;
  /** Full-size photograph, or the best available still for a clip. */
  readonly imageUri: string | undefined;
  /** Present only when this viewer is allowed to play the clip. */
  readonly videoUri?: string | undefined;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly status?: { readonly label: string; readonly color: string } | undefined;
}

function ViewerVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (instance) => {
    instance.muted = true;
    instance.loop = false;
    instance.play();
  });

  return (
    <VideoView
      player={player}
      style={styles.media}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture={false}
    />
  );
}

function ViewerPage({
  item,
  active,
  width,
  safeArea,
}: {
  item: MediaViewerItem;
  active: boolean;
  width: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}) {
  return (
    <View
      style={[
        styles.page,
        {
          width,
          paddingTop: safeArea.top + 68,
          paddingRight: safeArea.right,
          paddingBottom: safeArea.bottom + 188,
          paddingLeft: safeArea.left,
        },
      ]}
      accessibilityLabel={`Viewing ${item.title}`}
    >
      {item.mediaType === "video" && item.videoUri !== undefined && active ? (
        <ViewerVideo uri={item.videoUri} />
      ) : item.imageUri !== undefined ? (
        <Image
          source={{ uri: item.imageUri }}
          style={styles.media}
          contentFit="contain"
          transition={120}
          accessibilityLabel={item.title}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={styles.unavailable}>
          <Ionicons
            name={item.mediaType === "video" ? "videocam-off-outline" : "image-outline"}
            size={36}
            color={colors.textFaint}
          />
          <Text style={styles.unavailableText}>This item is not available right now.</Text>
        </View>
      )}
    </View>
  );
}

export function MediaViewer({
  items,
  selectedKey,
  onClose,
  onSelect,
  renderActions,
}: {
  items: readonly MediaViewerItem[];
  selectedKey: string | null;
  onClose: () => void;
  onSelect?: ((key: string) => void) | undefined;
  renderActions?: ((item: MediaViewerItem) => ReactNode) | undefined;
}) {
  const { width } = useWindowDimensions();
  const safeArea = useSafeAreaInsets();
  const list = useRef<FlatList<MediaViewerItem>>(null);
  const acceptSelectionEvents = useRef(selectedKey !== null);
  const requestedIndex =
    selectedKey === null ? 0 : items.findIndex((item) => item.key === selectedKey);
  const pageIndex = Math.max(0, requestedIndex);

  useEffect(() => {
    acceptSelectionEvents.current = selectedKey !== null;
  }, [selectedKey]);

  const closeViewer = useCallback(() => {
    // A paged FlatList can deliver its final momentum event while the modal's
    // fade-out is underway. Invalidate it before updating the parent; otherwise
    // that event re-selects the page we just closed and opens the modal again.
    acceptSelectionEvents.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (selectedKey === null) return;
    if (requestedIndex === -1) {
      closeViewer();
      return;
    }
    list.current?.scrollToIndex({ index: requestedIndex, animated: false });
  }, [closeViewer, requestedIndex, selectedKey]);

  const current = items[pageIndex];

  const moveTo = (nextIndex: number) => {
    if (!acceptSelectionEvents.current) return;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    const nextItem = items[nextIndex];
    if (nextItem !== undefined) onSelect?.(nextItem.key);
    list.current?.scrollToIndex({ index: nextIndex, animated: true });
  };

  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!acceptSelectionEvents.current) return;
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1));
    const boundedIndex = Math.min(items.length - 1, Math.max(0, nextIndex));
    const nextItem = items[boundedIndex];
    if (nextItem !== undefined) onSelect?.(nextItem.key);
  };

  return (
    <Modal
      visible={selectedKey !== null}
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={["portrait", "landscape"]}
      statusBarTranslucent
      onRequestClose={closeViewer}
    >
      <View style={styles.viewer}>
        <FlatList
          key={String(width)}
          ref={list}
          data={[...items]}
          horizontal
          pagingEnabled
          initialScrollIndex={pageIndex}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          renderItem={({ item, index }) => (
            <ViewerPage
              item={item}
              active={index === pageIndex}
              width={width}
              safeArea={safeArea}
            />
          )}
        />

        <View
          testID="media-viewer-top-controls"
          style={[
            styles.topBar,
            {
              top: safeArea.top + spacing.md,
              right: safeArea.right + spacing.lg,
              left: safeArea.left + spacing.lg,
            },
          ]}
          pointerEvents="box-none"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close media viewer"
            onPress={closeViewer}
            hitSlop={12}
            style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={23} color={colors.text} />
          </Pressable>
          <View style={styles.counter}>
            <Text style={styles.counterText}>
              {items.length === 0 ? "0 / 0" : `${String(pageIndex + 1)} / ${String(items.length)}`}
            </Text>
          </View>
        </View>

        {pageIndex > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous media"
            onPress={() => moveTo(pageIndex - 1)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.sideButton,
              { left: safeArea.left + spacing.sm },
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
        ) : null}

        {pageIndex < items.length - 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next media"
            onPress={() => moveTo(pageIndex + 1)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.sideButton,
              { right: safeArea.right + spacing.sm },
              pressed && styles.pressed,
            ]}
          >
            <Ionicons name="chevron-forward" size={24} color={colors.text} />
          </Pressable>
        ) : null}

        {current === undefined ? null : (
          <View
            testID="media-viewer-actions"
            style={[
              styles.footer,
              {
                right: safeArea.right + spacing.md,
                bottom: safeArea.bottom + spacing.md,
                left: safeArea.left + spacing.md,
              },
            ]}
          >
            <View style={styles.footerCopy}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {current.title}
                </Text>
                {current.status === undefined ? null : (
                  <View style={styles.status}>
                    <View style={[styles.statusDot, { backgroundColor: current.status.color }]} />
                    <Text style={[styles.statusLabel, { color: current.status.color }]}>
                      {current.status.label}
                    </Text>
                  </View>
                )}
              </View>
              {current.subtitle === undefined ? null : (
                <Text style={styles.subtitle} numberOfLines={2}>
                  {current.subtitle}
                </Text>
              )}
              {items.length > 1 ? (
                <Text style={styles.hint}>Swipe to move through the gallery</Text>
              ) : null}
            </View>
            {renderActions === undefined ? null : (
              <View style={styles.actions}>{renderActions(current)}</View>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: "#0C0611" },
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  media: { width: "100%", height: "100%" },
  unavailable: { alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xxl },
  unavailableText: { ...typography.body, color: colors.textMuted, textAlign: "center" },
  topBar: {
    position: "absolute",
    zIndex: 3,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  roundButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(29, 16, 41, 0.88)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  counter: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: "rgba(29, 16, 41, 0.88)",
  },
  counterText: { ...typography.label, color: colors.text },
  sideButton: {
    position: "absolute",
    zIndex: 2,
    top: "45%",
    width: 48,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(29, 16, 41, 0.78)",
  },
  pressed: { opacity: 0.62, transform: [{ scale: 0.96 }] },
  footer: {
    position: "absolute",
    zIndex: 3,
    maxHeight: 168,
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: "rgba(29, 16, 41, 0.96)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  footerCopy: { gap: spacing.xs },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { ...typography.heading, flex: 1, color: colors.text },
  subtitle: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
  hint: { ...typography.caption, color: colors.textFaint },
  status: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  statusDot: { width: 7, height: 7, borderRadius: radius.pill },
  statusLabel: { ...typography.caption, fontWeight: "700", textTransform: "uppercase" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
