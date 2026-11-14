/**
 * Value comparisons shared by the canvas and its views. The names state the
 * precision: `sameRectWithin` allows a small world-space drift, every other
 * comparator is exact per field.
 */
import type { Point, Rect } from "./geometry";

/** The world-unit tolerance `sameRectWithin` defaults to. */
export const RECT_EPSILON = 0.01;

/** Whether two nullable rectangles are exactly equal by value. */
export function sameBounds(first: Rect | null, second: Rect | null): boolean {
  if (first === second) return true;
  if (first === null || second === null) return false;
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  );
}

/**
 * Whether two nullable connector boxes are exactly equal by value. The name
 * says which box the caller compares; the comparison is `sameBounds`.
 */
export function sameBox(first: Rect | null, second: Rect | null): boolean {
  return sameBounds(first, second);
}

/** Whether two rectangles are exactly equal by value. */
export function sameRect(first: Rect, second: Rect): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  );
}

/**
 * Whether two rectangles agree within `epsilon` world units per field. A
 * sub-pixel drift must not count as a change; exact identity uses
 * `sameRect`.
 */
export function sameRectWithin(first: Rect, second: Rect, epsilon = RECT_EPSILON): boolean {
  return (
    Math.abs(first.x - second.x) <= epsilon &&
    Math.abs(first.y - second.y) <= epsilon &&
    Math.abs(first.width - second.width) <= epsilon &&
    Math.abs(first.height - second.height) <= epsilon
  );
}

/** Whether two nullable points are exactly equal by value. */
export function samePoint(first: Point | null, second: Point | null): boolean {
  if (first === second) return true;
  if (first === null || second === null) return false;
  return first.x === second.x && first.y === second.y;
}
