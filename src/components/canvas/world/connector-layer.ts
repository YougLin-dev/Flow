/** The screen-space box every connector canvas positions itself from. */
import type { Accessor } from "nsh";
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
 * every side. `origin` is where the layer's world (0, 0) lands on screen; the
 * draw callbacks use it to keep their paths in world coordinates.
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
