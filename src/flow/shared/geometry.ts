/**
 * Shared geometry shapes: the coordinate language the canvas, its views and
 * the document-facing helpers agree on.
 */

/** A point in world or screen coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A width and height. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle by origin and size. */
export interface Rect extends Point, Size {}

/** A rectangle with mutable fields, the canvas' bounds language. */
export interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether `a` and `b` meet; `margin` grows `b` on every side. */
export function overlaps(a: BoxGeometry, b: BoxGeometry, margin = 0): boolean {
  return (
    a.x <= b.x + b.width + margin &&
    a.x + a.width >= b.x - margin &&
    a.y <= b.y + b.height + margin &&
    a.y + a.height >= b.y - margin
  );
}

/** The box holding both boxes. */
export function mergeBounds(a: BoxGeometry, b: BoxGeometry): BoxGeometry {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Whether a point lies inside a rectangle, expanded by a margin. */
export function containsPoint(rect: Rect, x: number, y: number, margin = 0): boolean {
  return (
    x >= rect.x - margin &&
    x <= rect.x + rect.width + margin &&
    y >= rect.y - margin &&
    y <= rect.y + rect.height + margin
  );
}
