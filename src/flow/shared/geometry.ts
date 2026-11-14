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
