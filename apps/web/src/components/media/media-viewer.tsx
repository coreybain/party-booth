"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, type KeyboardEvent, type UIEvent } from "react";

import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "@/components/icons";
import { playableUrlOf, reviewUrlOf, stillUrlOf } from "@/components/media/media-tile";
import type { MediaItem, PublicGalleryItem } from "@/lib/convex-api";

export interface MediaViewerItem {
  readonly key: string;
  readonly mediaType: "photo" | "video";
  readonly imageUrl: string | undefined;
  readonly videoUrl: string | undefined;
  readonly title: string;
  readonly subtitle?: string;
  readonly challengePrompt?: string;
}

export function mediaViewerItemOf(
  item: MediaItem | PublicGalleryItem,
  title: string,
  subtitle?: string,
): MediaViewerItem {
  return {
    key: item.id,
    mediaType: item.mediaType,
    imageUrl: item.mediaType === "photo" ? reviewUrlOf(item) : stillUrlOf(item),
    videoUrl: item.mediaType === "video" ? playableUrlOf(item) : undefined,
    title,
    ...("challengePrompt" in item && item.challengePrompt !== undefined
      ? { challengePrompt: item.challengePrompt }
      : {}),
    ...(subtitle === undefined ? {} : { subtitle }),
  };
}

export function mediaViewerIndexForScroll(
  scrollLeft: number,
  pageWidth: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  const index = Math.round(scrollLeft / Math.max(1, pageWidth));
  return Math.min(itemCount - 1, Math.max(0, index));
}

export function adjacentMediaIndex(
  currentIndex: number,
  direction: -1 | 1,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  return Math.min(itemCount - 1, Math.max(0, currentIndex + direction));
}

export function MediaViewer({
  items,
  selectedKey,
  onClose,
  onSelect,
}: {
  readonly items: readonly MediaViewerItem[];
  readonly selectedKey: string | null;
  readonly onClose: () => void;
  readonly onSelect: (key: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const acceptSelectionEvents = useRef(selectedKey !== null);
  const visibleKey = useRef<string | null>(selectedKey);
  const selectedIndex = Math.max(
    0,
    selectedKey === null ? 0 : items.findIndex((item) => item.key === selectedKey),
  );

  const closeViewer = useCallback(() => {
    // A final scroll event can arrive after the close animation starts. Ignore
    // it synchronously so it cannot select an item and reopen the dialog.
    acceptSelectionEvents.current = false;
    visibleKey.current = null;
    onClose();
  }, [onClose]);

  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior) => {
      const container = scroller.current;
      const item = items[index];
      if (container === null || item === undefined) return;
      visibleKey.current = item.key;
      container.scrollTo({ left: container.clientWidth * index, behavior });
      onSelect(item.key);
    },
    [items, onSelect],
  );

  useEffect(() => {
    acceptSelectionEvents.current = selectedKey !== null;
    if (selectedKey === null) return;

    const index = items.findIndex((item) => item.key === selectedKey);
    if (index === -1) {
      closeViewer();
      return;
    }
    if (visibleKey.current === selectedKey && scroller.current?.scrollLeft !== 0) return;

    visibleKey.current = selectedKey;
    const frame = window.requestAnimationFrame(() => {
      const container = scroller.current;
      if (container === null) return;
      container.scrollTo({ left: container.clientWidth * index, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closeViewer, items, selectedKey]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!acceptSelectionEvents.current) return;
    const container = event.currentTarget;
    const index = mediaViewerIndexForScroll(
      container.scrollLeft,
      container.clientWidth,
      items.length,
    );
    const item = items[index];
    if (item === undefined || visibleKey.current === item.key) return;
    visibleKey.current = item.key;
    onSelect(item.key);
  };

  const move = (direction: -1 | 1) => {
    scrollToIndex(adjacentMediaIndex(selectedIndex, direction, items.length), "smooth");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === "ArrowLeft" && selectedIndex > 0) {
      event.preventDefault();
      move(-1);
    }
    if (event.key === "ArrowRight" && selectedIndex < items.length - 1) {
      event.preventDefault();
      move(1);
    }
  };

  return (
    <DialogPrimitive.Root
      open={selectedKey !== null}
      onOpenChange={(open) => {
        if (!open) closeViewer();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm data-[state=open]:animate-[sheet-overlay-in_180ms_ease-out] data-[state=closed]:animate-[sheet-overlay-out_130ms_ease-in]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-[60] overflow-hidden bg-bg text-ink outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Event gallery viewer</DialogPrimitive.Title>

          <div
            ref={scroller}
            onScroll={onScroll}
            className="flex h-dvh w-screen snap-x snap-mandatory touch-pan-x overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {items.map((item, index) => (
              <figure
                key={item.key}
                role="group"
                aria-roledescription="slide"
                aria-label={`${String(index + 1)} of ${String(items.length)}`}
                className="flex h-dvh w-screen shrink-0 snap-center flex-col items-center justify-center px-[max(1rem,env(safe-area-inset-left))] pb-[max(7rem,calc(env(safe-area-inset-bottom)+6rem))] pt-[max(5rem,calc(env(safe-area-inset-top)+4rem))]"
              >
                {item.mediaType === "video" && item.videoUrl !== undefined ? (
                  <video
                    src={item.videoUrl}
                    poster={item.imageUrl}
                    controls
                    playsInline
                    preload={index === selectedIndex ? "metadata" : "none"}
                    className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl"
                  />
                ) : item.imageUrl !== undefined ? (
                  // eslint-disable-next-line @next/next/no-img-element -- private signed URLs must not pass through the shared image optimizer.
                  <img
                    src={item.imageUrl}
                    alt={item.title}
                    decoding="async"
                    referrerPolicy="no-referrer"
                    className="max-h-full max-w-full select-none object-contain shadow-2xl"
                    draggable={false}
                  />
                ) : (
                  <div className="grid min-h-48 w-full max-w-sm place-items-center rounded-2xl border border-line bg-surface px-6 text-center text-sm text-muted">
                    This item is not available right now.
                  </div>
                )}
              </figure>
            ))}
          </div>

          <div className="pointer-events-none absolute left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] flex items-center justify-between gap-3">
            <DialogPrimitive.Close
              aria-label="Close gallery"
              className="pointer-events-auto grid size-12 place-items-center rounded-full border border-line bg-surface/90 text-ink shadow-lg transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <XIcon size={21} />
            </DialogPrimitive.Close>
            <span className="rounded-full border border-line bg-surface/90 px-3 py-1.5 text-sm font-medium tabular-nums shadow-lg">
              {items.length === 0
                ? "0 / 0"
                : `${String(selectedIndex + 1)} / ${String(items.length)}`}
            </span>
          </div>

          {selectedIndex > 0 ? (
            <button
              type="button"
              aria-label="Previous photo or video"
              onClick={() => move(-1)}
              className="absolute left-[max(0.5rem,env(safe-area-inset-left))] top-1/2 z-10 grid size-12 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/85 text-ink shadow-xl transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ArrowLeftIcon size={21} />
            </button>
          ) : null}

          {selectedIndex < items.length - 1 ? (
            <button
              type="button"
              aria-label="Next photo or video"
              onClick={() => move(1)}
              className="absolute right-[max(0.5rem,env(safe-area-inset-right))] top-1/2 z-10 grid size-12 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/85 text-ink shadow-xl transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ArrowRightIcon size={21} />
            </button>
          ) : null}

          {items[selectedIndex] === undefined ? null : (
            <div className="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] flex justify-center">
              <div className="max-w-md rounded-2xl border border-line bg-surface/95 px-4 py-3 text-center shadow-xl">
                <p className="text-sm font-medium text-ink">{items[selectedIndex]?.title}</p>
                {items[selectedIndex]?.subtitle === undefined ? null : (
                  <p className="mt-0.5 text-xs text-muted">{items[selectedIndex]?.subtitle}</p>
                )}
                {items[selectedIndex]?.challengePrompt === undefined ? null : (
                  <p className="mt-2 border-t border-line pt-2 text-sm font-medium text-plum">
                    Challenge: {items[selectedIndex]?.challengePrompt}
                  </p>
                )}
                {items.length > 1 ? (
                  <p className="mt-1 text-xs text-faint">Swipe or use the arrows to browse</p>
                ) : null}
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
