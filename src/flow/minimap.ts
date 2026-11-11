/**
 * The minimap's mapping between world coordinates and its small panel: one
 * uniform scale that fits the document together with the camera's viewport,
 * shared by the card silhouettes, the viewport rectangle and drag-to-pan.
 */
import type { Overview, Viewport } from "@flow/native";
import { sameBounds } from "./camera";

export { sameBounds };

export interface MinimapSize {
  readonly width: number;
  readonly height: number;
}

export interface MinimapLayout {
  /** Minimap points per world point. */
  readonly scale: number;
  /** Where world (0, 0) lands in minimap points. */
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface MinimapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a minimap drag began: a page point, the view's world center and
 * the map scale at that moment. */
export interface MinimapDrag {
  readonly point: { readonly x: number; readonly y: number };
  readonly center: { readonly x: number; readonly y: number };
  readonly scale: number;
}

/**
 * The world center the camera should show when the drag's pointer is at
 * `point`. The press scale is deliberate: converting with the shrunk union
 * scale would feed the map's own rescaling back into the drag.
 */
export function minimapDragCenter(
  drag: MinimapDrag,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  return {
    x: drag.center.x + (point.x - drag.point.x) / drag.scale,
    y: drag.center.y + (point.y - drag.point.y) / drag.scale,
  };
}

/** Fits `bounds` into `size` with equal margins, keeping its aspect ratio. */
export function minimapLayout(bounds: Viewport, size: MinimapSize, padding: number): MinimapLayout {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const scale = Math.min(availableWidth / width, availableHeight / height);
  return {
    scale,
    offsetX: (size.width - width * scale) / 2 - bounds.x * scale,
    offsetY: (size.height - height * scale) / 2 - bounds.y * scale,
  };
}

/** A world rectangle in minimap points; `minSize` keeps tiny cards visible. */
export function minimapRect(rect: Viewport, layout: MinimapLayout, minSize = 0): MinimapRect {
  return {
    x: layout.offsetX + rect.x * layout.scale,
    y: layout.offsetY + rect.y * layout.scale,
    width: Math.max(minSize, rect.width * layout.scale),
    height: Math.max(minSize, rect.height * layout.scale),
  };
}

/** The smallest world rectangle that holds both `first` and `second`. */
export function unionBounds(first: Viewport, second: Viewport): Viewport {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Compares two layouts by value, so a stable union allocates no new layout. */
export function sameLayout(first: MinimapLayout | null, second: MinimapLayout | null): boolean {
  if (first === second) return true;
  if (first === null || second === null) return false;
  return (
    first.scale === second.scale &&
    first.offsetX === second.offsetX &&
    first.offsetY === second.offsetY
  );
}

/** Whether two overview reads draw the same map (the revision is ignored). */
export function sameOverview(first: Overview | null, second: Overview): boolean {
  if (first === null) return false;
  if (!sameBounds(first.bounds, second.bounds)) return false;
  if (first.cards.length !== second.cards.length) return false;
  for (let index = 0; index < first.cards.length; index += 1) {
    const before = first.cards[index];
    const after = second.cards[index];
    if (before === undefined || after === undefined) return false;
    if (
      before.id !== after.id ||
      before.x !== after.x ||
      before.y !== after.y ||
      before.width !== after.width ||
      before.height !== after.height
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The camera's visible rectangle in minimap points, clamped to the panel. The
 * union layout already fits it; the clamp keeps the minimum size and absorbs
 * rounding at the edges.
 */
export function minimapViewport(
  visible: Viewport,
  layout: MinimapLayout,
  size: MinimapSize,
  minSize = 0,
): MinimapRect {
  const rect = minimapRect(visible, layout);
  const width = Math.min(size.width, Math.max(minSize, rect.width));
  const height = Math.min(size.height, Math.max(minSize, rect.height));
  return {
    x: Math.max(0, Math.min(rect.x, size.width - width)),
    y: Math.max(0, Math.min(rect.y, size.height - height)),
    width,
    height,
  };
}
