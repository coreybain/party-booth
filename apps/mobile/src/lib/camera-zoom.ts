/** Vertical travel that maps to the camera's full 0–1 zoom range. */
export const ZOOM_DRAG_RANGE_PX = 240;

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Instagram-style hold-and-slide zoom.
 *
 * Moving up increases zoom, returning to the press origin restores the zoom
 * that was active when the gesture began, and moving down zooms back out.
 */
export function zoomFromVerticalDrag(startZoom: number, startY: number, currentY: number): number {
  if (!Number.isFinite(startY) || !Number.isFinite(currentY)) return clampZoom(startZoom);
  return clampZoom(startZoom + (startY - currentY) / ZOOM_DRAG_RANGE_PX);
}
