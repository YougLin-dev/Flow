/** The world-space box every connector canvas positions itself from. */
import type { Accessor, CanvasRenderingContext2D } from "nsh";
import type { Point, Rect } from "../../../flow/shared";

export interface ConnectorLayerView {
  readonly left: () => number;
  readonly top: () => number;
  readonly width: () => number;
  readonly height: () => number;
  /** The canvas' world origin, or null while it has no box. */
  readonly origin: () => Point | null;
}

/**
 * The canvas style values for a connector layer box, padded by `padding` on
 * every side. `origin` is the world coordinate that maps to the canvas' (0,
 * 0): a world point p draws at p - origin.
 */
export function connectorLayerView(box: Accessor<Rect | null>, padding = 0): ConnectorLayerView {
  return {
    left: () => (box()?.x ?? 0) - padding,
    top: () => (box()?.y ?? 0) - padding,
    width: () => (box()?.width ?? 0) + padding * 2,
    height: () => (box()?.height ?? 0) + padding * 2,
    origin: () => {
      const current = box();
      if (current === null) return null;
      return { x: current.x - padding, y: current.y - padding };
    },
  };
}

/** Traces one connector cubic in canvas coordinates from its world origin. */
export function traceCubic(
  cx: CanvasRenderingContext2D,
  origin: Point,
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
): void {
  cx.moveTo(from.x - origin.x, from.y - origin.y);
  cx.bezierCurveTo(
    c1.x - origin.x,
    c1.y - origin.y,
    c2.x - origin.x,
    c2.y - origin.y,
    to.x - origin.x,
    to.y - origin.y,
  );
}
