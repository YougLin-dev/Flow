/** Pure geometry for selection, resizing, marquee selection and placement. */
import { overlaps, type BoxGeometry } from "./connection";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Whether a screen point lies inside a rectangle, expanded by a margin. */
export function containsPoint(rect: ScreenRect, x: number, y: number, margin = 0): boolean {
  return (
    x >= rect.x - margin &&
    x <= rect.x + rect.width + margin &&
    y >= rect.y - margin &&
    y <= rect.y + rect.height + margin
  );
}

/**
 * The resize side under a screen point: a corner, or any point along an edge
 * within `radius` of it. Corners win over the edges they touch.
 */
export function handleAt(rect: ScreenRect, x: number, y: number, radius = 7): ResizeHandle | null {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (x < left - radius || x > right + radius || y < top - radius || y > bottom + radius) {
    return null;
  }
  const nearLeft = Math.abs(x - left) <= radius;
  const nearRight = Math.abs(x - right) <= radius;
  const nearTop = Math.abs(y - top) <= radius;
  const nearBottom = Math.abs(y - bottom) <= radius;
  if (nearTop && nearLeft) return "nw";
  if (nearTop && nearRight) return "ne";
  if (nearBottom && nearRight) return "se";
  if (nearBottom && nearLeft) return "sw";
  if (nearTop) return "n";
  if (nearBottom) return "s";
  if (nearLeft) return "w";
  if (nearRight) return "e";
  return null;
}

/** A rectangle from two corners (drag direction independent). */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number): ScreenRect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Whether two world rectangles overlap (touching edges count). */
export function intersects(a: BoxGeometry, b: BoxGeometry): boolean {
  return overlaps(a, b);
}

/**
 * A card resized by a handle drag, never below its minimum size. A corner
 * keeps the start rectangle's aspect ratio and the opposite corner fixed; its
 * scale is the pointer's projection onto the card's diagonal, which is
 * continuous through an edge crossing, so passing the top or left edge alone
 * never collapses the card to its minimum. An edge resizes one axis only.
 */
export function resizedRect(
  start: BoxGeometry,
  side: ResizeHandle,
  dx: number,
  dy: number,
  minWidth = 120,
  minHeight = 80,
): BoxGeometry {
  if (side === "nw" || side === "ne" || side === "se" || side === "sw") {
    const west = side === "nw" || side === "sw";
    const north = side === "nw" || side === "ne";
    // The dragged corner's distances from the fixed opposite corner.
    const movingWidth = start.width + (west ? -dx : dx);
    const movingHeight = start.height + (north ? -dy : dy);
    const safeWidth = Math.max(1, start.width);
    const safeHeight = Math.max(1, start.height);
    // Project the pointer onto the card's diagonal: the corner lands on the
    // closest point of the aspect line, so the scale changes continuously
    // through an edge crossing instead of switching axes or snapping.
    const scale =
      (movingWidth * safeWidth + movingHeight * safeHeight) /
      (safeWidth * safeWidth + safeHeight * safeHeight);
    const minScale = Math.max(minWidth / safeWidth, minHeight / safeHeight);
    const effective = Math.max(minScale, scale);
    const width = Math.round(Math.max(1, start.width * effective));
    const height = Math.round(Math.max(1, start.height * effective));
    return {
      x: west ? start.x + start.width - width : start.x,
      y: north ? start.y + start.height - height : start.y,
      width,
      height,
    };
  }

  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let { x, y, width, height } = start;
  if (side === "w") {
    const nextX = Math.min(x + dx, right - minWidth);
    width = right - nextX;
    x = nextX;
  } else if (side === "e") {
    width = Math.max(minWidth, width + dx);
  }
  if (side === "n") {
    const nextY = Math.min(y + dy, bottom - minHeight);
    height = bottom - nextY;
    y = nextY;
  } else if (side === "s") {
    height = Math.max(minHeight, height + dy);
  }
  width = Math.max(1, minWidth, Math.round(width));
  height = Math.max(1, minHeight, Math.round(height));
  if (side === "w") x = right - width;
  if (side === "n") y = bottom - height;
  return { x, y, width, height };
}
