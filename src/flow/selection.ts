/** Pure geometry for selection, resizing, marquee selection and placement. */
import type { BoxGeometry } from "./connection";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HandlePoint {
  readonly side: ResizeHandle;
  readonly x: number;
  readonly y: number;
}

/** The eight resize handles of a screen rectangle, in a stable order. */
export function selectionHandles(rect: ScreenRect): HandlePoint[] {
  const left = rect.x;
  const centerX = rect.x + rect.width / 2;
  const right = rect.x + rect.width;
  const top = rect.y;
  const centerY = rect.y + rect.height / 2;
  const bottom = rect.y + rect.height;
  return [
    { side: "nw", x: left, y: top },
    { side: "n", x: centerX, y: top },
    { side: "ne", x: right, y: top },
    { side: "e", x: right, y: centerY },
    { side: "se", x: right, y: bottom },
    { side: "s", x: centerX, y: bottom },
    { side: "sw", x: left, y: bottom },
    { side: "w", x: left, y: centerY },
  ];
}

/** The handle under a screen point, within `radius` points of its center. */
export function handleAt(rect: ScreenRect, x: number, y: number, radius = 7): ResizeHandle | null {
  for (const handle of selectionHandles(rect)) {
    if (Math.abs(handle.x - x) <= radius && Math.abs(handle.y - y) <= radius) return handle.side;
  }
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
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}

/** A card resized by a handle drag, never below its minimum size. */
export function resizedRect(
  start: BoxGeometry,
  side: ResizeHandle,
  dx: number,
  dy: number,
  minWidth = 120,
  minHeight = 80,
): BoxGeometry {
  let { x, y, width, height } = start;
  if (side === "nw" || side === "w" || side === "sw") {
    const right = x + width;
    const nextX = Math.min(x + dx, right - minWidth);
    width = right - nextX;
    x = nextX;
  } else if (side === "ne" || side === "e" || side === "se") {
    width = Math.max(minWidth, width + dx);
  }
  if (side === "nw" || side === "n" || side === "ne") {
    const bottom = y + height;
    const nextY = Math.min(y + dy, bottom - minHeight);
    height = bottom - nextY;
    y = nextY;
  } else if (side === "sw" || side === "s" || side === "se") {
    height = Math.max(minHeight, height + dy);
  }
  return { x, y, width, height };
}
